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

// Client-supplied executable names must resolve to a known CLI (by basename), so a request
// body can never point us at an arbitrary program. validateOption already blocks shell
// metacharacters; this also blocks non-allowlisted commands / bare paths.
const ALLOWED_CLI = new Set(["claude", "codex", "gh", "git"]);
export function allowedCommand(input, allowed = ALLOWED_CLI) {
  const cmd = validateOption(input, "Command", { allowEmpty: false });
  // On Windows runProcess uses shell:true, and cmd.exe re-tokenizes on spaces — so
  // "calc /claude" (basename "claude") would actually run calc. Ban internal whitespace
  // there to close that split-parsing bypass. On POSIX runProcess uses shell:false, so a
  // full path like "/Users/Jane Doe/bin/codex" is passed as a single safe argument — don't
  // reject it (validateOption already blocks shell metacharacters on every platform).
  if (process.platform === "win32" && /\s/.test(cmd)) throw new Error("Command must not contain spaces");
  const base = cmd.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  if (!allowed.has(base)) throw new Error(`Command not allowed — only: ${[...allowed].join(", ")}`);
  return cmd;
}

const TRUNCATED = "…[truncated]\n";
// Append `line\n` to a retained buffer without letting it exceed `max`. readline delivers
// whole lines (at EOF a child can emit one line far larger than `max`), so gating only on
// the current length would append the entire oversized line — we must slice the chunk to the
// remaining room. Adds a one-time truncation marker and never grows past ~max + marker.
function appendCapped(buf, line, max) {
  if (buf.length >= max) return buf.endsWith(TRUNCATED) ? buf : buf + TRUNCATED;
  const chunk = `${line}\n`;
  const room = max - buf.length;
  return chunk.length <= room ? buf + chunk : buf + chunk.slice(0, room) + TRUNCATED;
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
    // Cap each accumulated stream so a verbose/runaway CLI can't grow memory without bound.
    // Streaming (onStdoutLine/onStderrLine) still gets every line; only the retained buffer
    // is capped, with a one-time truncation marker appended.
    const MAX_BUF = 4 * 1024 * 1024;
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
      stdout = appendCapped(stdout, line, MAX_BUF);
      onStdoutLine?.(line);
    });

    const stderrRl = readline.createInterface({ input: child.stderr });
    stderrRl.on("line", (line) => {
      stderr = appendCapped(stderr, line, MAX_BUF);
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

// immediate:true sends SIGKILL synchronously instead of SIGTERM-then-escalate. Use it at
// shutdown: the escalation timer is unref'd and would be beaten by the ~1500ms process.exit,
// so a detached child that ignores SIGTERM could outlive the server. A synchronous SIGKILL
// on the process group can't be caught/ignored and is delivered before we exit.
export function terminateProcess(child, { immediate = false } = {}) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {});
    } else if (child.pid) {
      if (immediate) { process.kill(-child.pid, "SIGKILL"); return; }
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 2500).unref();
    } else {
      child.kill(immediate ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    try { child.kill(immediate ? "SIGKILL" : "SIGTERM"); } catch {}
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
