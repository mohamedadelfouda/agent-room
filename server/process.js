import { spawn, execFile } from "node:child_process";
import readline from "node:readline";

const SAFE_OPTION = /^[\p{L}\p{N}._:\/\\\-\[\]@+ ]*$/u;

export function validateOption(value, label, { allowEmpty = true } = {}) {
  const text = String(value ?? "").trim();
  if (!text && allowEmpty) return "";
  if (!text) throw new Error(`${label} is required`);
  if (text.length > 180 || !SAFE_OPTION.test(text)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return text;
}

export function runProcess({ command, args = [], input = "", cwd, env = {}, onStdoutLine, onStderrLine, timeoutMs = 0, registerChild }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    registerChild?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    child.on("error", (error) => finish(reject, error));

    const stdoutRl = readline.createInterface({ input: child.stdout });
    stdoutRl.on("line", (line) => {
      stdout += `${line}\n`;
      onStdoutLine?.(line);
    });

    const stderrRl = readline.createInterface({ input: child.stderr });
    stderrRl.on("line", (line) => {
      stderr += `${line}\n`;
      onStderrLine?.(line);
    });

    child.on("close", (code, signal) => {
      finish(resolve, { code: code ?? -1, signal, stdout, stderr, child });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        terminateProcess(child);
        finish(reject, new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

export function terminateProcess(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {});
    } else if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 2500).unref();
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

export async function checkCommand(command) {
  const safe = validateOption(command, "Command", { allowEmpty: false });
  try {
    const result = await runProcess({ command: safe, args: ["--version"], timeoutMs: 8000 });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return { ok: result.code === 0, version: text.split(/\r?\n/)[0] || "Detected", detail: text };
  } catch (error) {
    return { ok: false, version: "", detail: error.message };
  }
}
