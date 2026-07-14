$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AgentRoomJob {
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public UInt64 ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public UInt64 ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT_INFORMATION {
    public BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

  public static IntPtr EnterKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    var info = new EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x00002000;
    int size = Marshal.SizeOf(info);
    IntPtr pointer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, pointer, false);
      if (!SetInformationJobObject(job, 9, pointer, (uint)size)) throw new System.ComponentModel.Win32Exception();
      if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new System.ComponentModel.Win32Exception();
      return job;
    } catch { CloseHandle(job); throw; }
    finally { Marshal.FreeHGlobal(pointer); }
  }
}
"@

function Quote-NativeArgument([string]$value) {
  if ($value.Length -eq 0) { return '""' }
  if ($value -notmatch '[\s"]') { return $value }
  $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

if ($args.Count -ne 1) { throw "Expected one encoded launch payload" }
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0])) | ConvertFrom-Json
$job = [AgentRoomJob]::EnterKillOnCloseJob()
try {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = [string]$payload.command
  $info.Arguments = (($payload.args | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  if (-not $process.Start()) { throw "Failed to start contained process" }
  # Copy raw streams as they arrive. ReadToEndAsync would buffer an agent's full
  # response inside PowerShell and would hide progress until the process exits.
  $stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $stdin = [Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)
  [void]$stdin.GetAwaiter().GetResult()
  $process.StandardInput.Close()
  $process.WaitForExit()
  [void]$stdout.GetAwaiter().GetResult()
  [void]$stderr.GetAwaiter().GetResult()
  exit $process.ExitCode
} finally {
  [AgentRoomJob]::CloseHandle($job) | Out-Null
}
