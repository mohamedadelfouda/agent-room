import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CappedText, MAX_PROCESS_OUTPUT_BYTES, MAX_STREAM_LINE_BYTES } from "./output-limits.js";
import { redact } from "./logger.js";

const SAFE_OPTION = /^[\p{L}\p{N}._:\/\\\-\[\]@+ ]*$/u;
const sourceJobRunner = fileURLToPath(new URL("./windows-job-runner.ps1", import.meta.url));

function windowsJobRunnerPath() {
  return sourceJobRunner.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

export function validateOption(value, label, { allowEmpty = true } = {}) {
  const text = String(value ?? "").trim();
  if (!text && allowEmpty) return "";
  if (!text) throw new Error(`${label} is required`);
  if (text.length > 180 || !SAFE_OPTION.test(text)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return text;
}

// A command can be a bare allowlisted CLI name or an absolute path to that CLI. Relative
// paths are rejected so an untrusted project cannot shadow `codex` / `claude`. Arguments are
// always passed to spawn with shell:false, so paths and individual arguments may contain spaces
// without being re-tokenized by cmd.exe or a POSIX shell.
const ALLOWED_CLI = new Set(["claude", "codex", "gh", "git"]);
export function allowedCommand(input, allowed = ALLOWED_CLI, { trustedPaths = [] } = {}) {
  const cmd = String(input ?? "").trim();
  if (!cmd) throw new Error("Command is required");
  // Executable paths can legitimately contain characters such as `~` and
  // parentheses. They are passed to spawn with shell:false, so reject only
  // control characters/absurd length here and enforce the basename + trust
  // boundary below.
  if (cmd.length > 4096 || /[\0\r\n]/.test(cmd)) throw new Error("Command contains unsupported characters");
  if (/\.(cmd|bat|ps1)$/i.test(cmd)) throw new Error("Shell command shims are not supported; select the native executable");
  const hasSeparator = /[\\/]/.test(cmd);
  if (!hasSeparator && !/^[A-Za-z0-9._-]+$/.test(cmd)) throw new Error("Command contains unsupported characters");
  if (hasSeparator && !path.isAbsolute(cmd)) throw new Error("Command path must be absolute");
  const base = cmd.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  if (!allowed.has(base)) throw new Error(`Command not allowed — only: ${[...allowed].join(", ")}`);
  if (path.isAbsolute(cmd)) {
    const normalize = (value) => {
      const normalized = path.normalize(path.resolve(value));
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    const trusted = new Set(trustedPaths.filter(Boolean).map(normalize));
    if (!trusted.has(normalize(cmd))) throw new Error("Absolute command path has not been trusted by Agent Room");
  }
  return cmd;
}

const resolvedCommands = new Map();
const approvedProviderCommands = new Map();

// Persisted approvals survive process restarts. Unconfigured (tests) stays
// in-memory only so the suite never writes into the developer's data folder.
let trustedCliStorePath = "";
let persistApprovedChain = Promise.resolve();

export function configureTrustedCliStore(filePath) {
  trustedCliStorePath = String(filePath || "");
}

export function approvedProviderCommand(providerId) {
  return approvedProviderCommands.get(String(providerId || "")) || "";
}

async function persistApprovedProviderCommands() {
  if (!trustedCliStorePath) return;
  // Serialize writes so two concurrent approvals cannot rename a stale
  // snapshot over a newer one. Each turn reads the Map after prior writes.
  const storePath = trustedCliStorePath;
  const run = persistApprovedChain.then(async () => {
    if (!storePath) return;
    const payload = Object.fromEntries(approvedProviderCommands);
    const tempPath = `${storePath}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, storePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  });
  persistApprovedChain = run.then(() => {}, () => {});
  return run;
}

// Re-load prior Trust & check approvals. Each path is re-validated (exists,
// native executable, allowlisted basename) so a stale or swapped file cannot
// silently become trusted again after a restart.
export async function hydrateTrustedProviderCommands({ allowed = ALLOWED_CLI } = {}) {
  if (!trustedCliStorePath) return;
  let raw;
  try {
    raw = await fs.readFile(trustedCliStorePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  for (const [providerId, commandPath] of Object.entries(parsed)) {
    if (!/^[a-z0-9_-]+$/.test(providerId)) continue;
    if (!path.isAbsolute(String(commandPath || ""))) continue;
    try {
      const resolved = await resolveAllowedCommand(commandPath, allowed, { trustedPaths: [commandPath] });
      approvedProviderCommands.set(providerId, resolved);
    } catch {
      // Drop entries that no longer resolve — user can Trust & check again.
    }
  }
}

async function executablePath(candidate) {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile()) return "";
    await fs.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.realpath(candidate);
  } catch {
    return "";
  }
}

function commandCandidates(command, searchPath) {
  const directories = String(searchPath || "").split(path.delimiter).filter(Boolean);
  if (process.platform !== "win32") return directories.map((directory) => path.join(directory, command));
  const extension = path.extname(command).toLowerCase();
  const executableNames = extension ? [command] : [`${command}.exe`, `${command}.com`];
  return directories.flatMap((directory) => executableNames.map((name) => path.join(directory, name)));
}

export function nativeCliSearchPath(source = process.env) {
  const home = source.USERPROFILE || source.HOME || "";
  const extras = process.platform === "win32"
    ? [path.join(home, ".local", "bin"), path.join(home, "AppData", "Local", "Microsoft", "WindowsApps")]
    : process.platform === "darwin"
      ? [path.join(home, ".local", "bin"), path.join(home, "Library", "pnpm"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
      : [path.join(home, ".local", "bin"), path.join(home, ".local", "share", "pnpm"), "/usr/local/bin", "/usr/bin"];
  return [...new Set([String(source.PATH || "").split(path.delimiter), extras].flat().filter(Boolean))].join(path.delimiter);
}

export async function resolveAllowedCommand(input, allowed = ALLOWED_CLI, options = {}) {
  const raw = String(input ?? "").trim();
  if (path.isAbsolute(raw)) {
    const command = allowedCommand(raw, allowed, { trustedPaths: [raw] });
    const resolved = await executablePath(command);
    if (!resolved) throw new Error(`Trusted command is not an executable file: ${command}`);
    const trusted = (await Promise.all((options.trustedPaths || []).filter(Boolean).map(executablePath))).filter(Boolean);
    const normalize = (value) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
    if (!new Set(trusted.map(normalize)).has(normalize(resolved))) {
      throw new Error("Absolute command path has not been trusted by Agent Room");
    }
    return resolved;
  }
  const command = allowedCommand(raw, allowed, options);
  const searchPath = options.searchPath ?? nativeCliSearchPath();
  const cacheKey = `${process.platform}\0${command}\0${searchPath}`;
  if (resolvedCommands.has(cacheKey)) return resolvedCommands.get(cacheKey);
  for (const candidate of commandCandidates(command, searchPath)) {
    const resolved = await executablePath(candidate);
    if (resolved) {
      resolvedCommands.set(cacheKey, resolved);
      return resolved;
    }
  }
  throw new Error(`Command not found on PATH: ${command}`);
}

export async function approveProviderCommand(providerId, input, allowed) {
  if (!/^[a-z0-9_-]+$/.test(String(providerId || ""))) throw new Error("Invalid provider id");
  if (!path.isAbsolute(String(input || ""))) throw new Error("Only an explicitly selected absolute path needs approval");
  const resolved = await resolveAllowedCommand(input, allowed, { trustedPaths: [input] });
  const hadPrevious = approvedProviderCommands.has(providerId);
  const previous = hadPrevious ? approvedProviderCommands.get(providerId) : "";
  approvedProviderCommands.set(providerId, resolved);
  try {
    await persistApprovedProviderCommands();
  } catch (error) {
    // Roll memory back only if this approval is still the latest for the
    // provider — a newer concurrent approve must not be wiped by our failure.
    if (approvedProviderCommands.get(providerId) === resolved) {
      if (hadPrevious) approvedProviderCommands.set(providerId, previous);
      else approvedProviderCommands.delete(providerId);
    }
    throw error;
  }
  return resolved;
}

const AGENT_ENV_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
  "SHELL", "LANG", "LANGUAGE", "LC_ALL", "TERM", "COLORTERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

export function sanitizedAgentEnv(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && AGENT_ENV_KEYS.has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

// Publishing is still credential-minimal. The only extra value compared with an
// agent process is the user's SSH-agent socket, which Git needs for an explicitly
// approved push. Private keys and unrelated host credentials are never copied.
export function sanitizedPublicationEnv(source = process.env) {
  const result = sanitizedAgentEnv(source);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key.toUpperCase() === "SSH_AUTH_SOCK") result[key] = value;
  }
  return result;
}

export function sanitizedGithubEnv(source = process.env) {
  const result = sanitizedPublicationEnv(source);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"]).has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

function processEnv(policy, overrides) {
  let base;
  if (policy === "agent") base = sanitizedAgentEnv();
  else if (policy === "publication") base = sanitizedPublicationEnv();
  else if (policy === "github") base = sanitizedGithubEnv();
  else if (policy === "inherit") base = { ...process.env };
  else throw new Error(`Unsupported process environment policy: ${policy}`);
  return { ...base, ...overrides };
}

function attachLineStream(stream, onLine, retained, maxLineBytes = MAX_STREAM_LINE_BYTES) {
  let chunks = [];
  let bytes = 0;
  let lineTruncated = false;
  let ended = false;

  const appendSegment = (segment) => {
    const room = maxLineBytes - bytes;
    if (room > 0) {
      const kept = segment.length <= room ? segment : segment.subarray(0, room);
      chunks.push(kept);
      bytes += kept.length;
    }
    if (segment.length > room) lineTruncated = true;
  };

  const flush = () => {
    if (chunks.length === 0 && !lineTruncated) return;
    let line = Buffer.concat(chunks, bytes).toString("utf8").replace(/\r$/, "");
    if (lineTruncated) line += "…[line truncated]";
    onLine?.(line);
    chunks = [];
    bytes = 0;
    lineTruncated = false;
  };

  stream.on("data", (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    retained.append(chunk);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 10) continue;
      appendSegment(chunk.subarray(start, index));
      flush();
      start = index + 1;
    }
    if (start < chunk.length) appendSegment(chunk.subarray(start));
  });
  stream.on("end", () => { ended = true; flush(); });
  return () => { if (!ended) flush(); };
}

function attachRetainedStream(stream, retained) {
  stream.on("data", (value) => retained.append(Buffer.isBuffer(value) ? value : Buffer.from(value)));
  return () => {};
}

export function runProcess({ command, args = [], input = "", cwd, env = {}, envPolicy = "agent", onStdoutLine, onStderrLine, timeoutMs = 0, registerChild, maxOutputBytes = MAX_PROCESS_OUTPUT_BYTES, binaryOutput = false, containTree = false }) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024 * 1024) {
      reject(new Error("maxOutputBytes must be between 1 byte and 64 MiB"));
      return;
    }
    let child;
    try {
      let launchCommand = command;
      let launchArgs = args;
      if (containTree && process.platform === "win32") {
        launchCommand = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const payload = Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
        launchArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsJobRunnerPath(), payload];
      }
      child = spawn(launchCommand, launchArgs, {
        cwd,
        env: processEnv(envPolicy, env),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Closing this wrapper closes its KillOnJobClose handle, so Windows kills
      // every descendant without a slow/racy WMI tree walk.
      child.agentRoomContainedTree = containTree;
    } catch (error) {
      reject(error);
      return;
    }

    registerChild?.(child);
    const stdout = new CappedText(maxOutputBytes);
    const stderr = new CappedText(Math.min(maxOutputBytes, MAX_PROCESS_OUTPUT_BYTES));
    let settled = false;
    let timeoutError = null;
    let timer;
    let containmentPromise = Promise.resolve(true);

    if (containTree && process.platform !== "win32") {
      child.once("exit", () => {
        containmentPromise = terminatePosixProcessGroup(child);
      });
    }

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    child.on("error", (error) => finish(reject, error));

    const flushStdout = onStdoutLine ? attachLineStream(child.stdout, onStdoutLine, stdout) : attachRetainedStream(child.stdout, stdout);
    const flushStderr = onStderrLine ? attachLineStream(child.stderr, onStderrLine, stderr) : attachRetainedStream(child.stderr, stderr);

    child.on("close", async (code, signal) => {
      flushStdout();
      flushStderr();
      if (timeoutError) return;
      if (!await containmentPromise) {
        const error = new Error("Process descendants could not be terminated");
        error.terminationFailed = true;
        finish(reject, error);
        return;
      }
      finish(resolve, {
        code: code ?? -1,
        signal,
        stdout: binaryOutput ? "" : stdout.toString(),
        stdoutBuffer: binaryOutput ? stdout.toBuffer() : undefined,
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        child,
      });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(async () => {
        timeoutError = new Error(`Process timed out after ${timeoutMs}ms`);
        const terminated = await terminateProcess(child);
        if (!terminated) timeoutError.terminationFailed = true;
        finish(reject, timeoutError);
      }, timeoutMs);
      timer.unref?.();
    }

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(hasExited(child)); }, timeoutMs);
    timer.unref?.();
    const onClose = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); child.off("close", onClose); };
    child.once("close", onClose);
  });
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    execFile(executable, ["/pid", String(pid), "/t", "/f"], { windowsHide: true, timeout: 5000, killSignal: "SIGKILL" }, (error) => resolve(!error));
  });
}

function powershellKillTree(pid) {
  const rootId = Number(pid);
  if (!Number.isSafeInteger(rootId) || rootId < 1) return Promise.resolve(false);
  const script = [
    "$ErrorActionPreference='Stop'",
    `$rootId=${rootId}`,
    "$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
    "$pending=@($rootId)",
    "$targets=@()",
    "while($pending.Count -gt 0){$parentId=$pending[0];$pending=@($pending | Select-Object -Skip 1);$children=@($all | Where-Object {$_.ParentProcessId -eq $parentId} | ForEach-Object {$_.ProcessId});$targets+=@($children);$pending+=@($children)}",
    "$ordered=@($targets | Sort-Object -Descending)+@($rootId)",
    "foreach($processId in $ordered){Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue}",
    "Start-Sleep -Milliseconds 100",
    "$alive=@($ordered | Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue})",
    "if($alive.Count -gt 0){exit 1}",
  ].join(";");
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFile(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000, killSignal: "SIGKILL" }, (error) => resolve(!error));
  });
}

function signalChild(child, signal, group = false) {
  try {
    if (group && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    try { child.kill(signal); return true; } catch { return false; }
  }
}

function processGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export function parsePosixProcessGroupLiveness(output, processGroupId) {
  const target = String(processGroupId);
  let parsedRow = false;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\S+)\s*$/);
    if (!match) continue;
    parsedRow = true;
    if (match[1] !== target) continue;
    if (!match[2].toUpperCase().startsWith("Z")) return true;
  }
  if (!parsedRow) return null;
  return false;
}

function inspectPosixProcessGroup(pid) {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-A", "-o", "pgid=", "-o", "state="],
      {
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 1000,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : parsePosixProcessGroupLiveness(stdout, pid)),
    );
  });
}

async function processGroupHasLiveMembers(pid) {
  if (!processGroupAlive(pid)) return false;
  const inspected = await inspectPosixProcessGroup(pid);
  // If ps is unavailable or its output changes unexpectedly, keep the old
  // fail-closed behavior and report the group as live.
  return inspected !== false;
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await processGroupHasLiveMembers(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !await processGroupHasLiveMembers(pid);
}

async function terminatePosixProcessGroup(child, { immediate = false, graceMs = 2500 } = {}) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1 || !await processGroupHasLiveMembers(pid)) return true;
  signalChild(child, immediate ? "SIGKILL" : "SIGTERM", true);
  if (immediate || await waitForProcessGroupExit(pid, graceMs)) return waitForProcessGroupExit(pid, 750);
  signalChild(child, "SIGKILL", true);
  return waitForProcessGroupExit(pid, 750);
}

export async function terminateProcess(child, { immediate = false, graceMs = 2500 } = {}) {
  if (!child) return true;

  if (process.platform !== "win32" && child.agentRoomContainedTree) {
    return terminatePosixProcessGroup(child, { immediate, graceMs });
  }

  if (hasExited(child)) return true;

  if (process.platform === "win32" && child.pid) {
    if (child.agentRoomContainedTree) {
      signalChild(child, "SIGKILL");
      return waitForExit(child, 1500);
    }
    const treeKilled = await powershellKillTree(child.pid);
    if (treeKilled && await waitForExit(child, 750)) return true;
    const requested = await taskkillTree(child.pid);
    if (requested && await waitForExit(child, 750)) return true;
    signalChild(child, "SIGKILL");
    return waitForExit(child, 750);
  }

  signalChild(child, immediate ? "SIGKILL" : "SIGTERM", Boolean(child.pid));
  if (immediate || await waitForExit(child, graceMs)) return waitForExit(child, 750);
  signalChild(child, "SIGKILL", Boolean(child.pid));
  return waitForExit(child, 750);
}

export async function checkCommand(command, options = {}) {
  try {
    const resolved = await resolveAllowedCommand(command, options.allowedCommands || ALLOWED_CLI, options);
    const result = await runProcess({ command: resolved, args: ["--version"], timeoutMs: 8000 });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const safeText = redact(text);
    return { ok: result.code === 0, version: safeText.split(/\r?\n/)[0] || "Detected", detail: safeText };
  } catch (error) {
    return { ok: false, version: "", detail: redact(error.message) };
  }
}
