import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvedProviderCommand, runProcess, validateOption, resolveAllowedCommand } from "../process.js";
import { redact } from "../logger.js";
import { agentTimeoutMs, readTextFileCapped } from "../output-limits.js";

function extractSessionId(value, depth = 0) {
  if (!value || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractSessionId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const key of ["thread_id", "threadId", "session_id", "sessionId"]) {
    if (typeof value[key] === "string" && value[key].length > 8) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = extractSessionId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractActivity(event) {
  const type = String(event?.type || event?.event || "");
  if (type.includes("error")) return { kind: "error", text: event.message || event.error?.message || type };
  if (type.includes("reason") || type.includes("thinking")) return { kind: "thinking", text: "Codex is reasoning…" };
  if (type.includes("item") || type.includes("message") || type.includes("turn")) return { kind: "activity", text: type };
  return null;
}

function extractCodexError(parsed) {
  let raw = parsed?.error?.message ?? parsed?.message ?? "";
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try { const inner = JSON.parse(raw); raw = inner?.error?.message || inner?.message || raw; } catch {}
  }
  return String(raw || "").trim() || null;
}

const MAX_CODEX_AUTH_BYTES = 2 * 1024 * 1024;
const DISABLED_CODEX_FEATURES = ["apps", "hooks", "multi_agent", "memories"];

function codexHomeFrom(source = process.env) {
  if (source.CODEX_HOME) return path.resolve(source.CODEX_HOME);
  const home = source.USERPROFILE || source.HOME || os.homedir();
  return path.join(home, ".codex");
}

async function findProjectRoot(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    try {
      await fs.stat(path.join(current, ".git"));
      return current;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export function codexSecurityOverrides(permission = "read") {
  const overrides = [
    `web_search=${JSON.stringify(permission === "chat" ? "live" : "disabled")}`,
    "mcp_servers={}",
    ...DISABLED_CODEX_FEATURES.map((feature) => `features.${feature}=false`),
  ];
  return overrides.flatMap((override) => ["-c", override]);
}

function isolatedCodexConfig(cwd, projectRoot) {
  const roots = new Set([path.resolve(cwd), projectRoot]);
  const trustEntries = [...roots]
    .map((root) => `[projects.${JSON.stringify(root)}]\ntrust_level = "untrusted"`)
    .join("\n\n");
  const features = DISABLED_CODEX_FEATURES.map((feature) => `${feature} = false`).join("\n");
  return [
    "check_for_update_on_startup = false",
    'web_search = "disabled"',
    "mcp_servers = {}",
    "",
    "[features]",
    features,
    "",
    trustEntries,
    "",
  ].join("\n");
}

async function copyCodexAuth(isolatedHome, sourceEnv) {
  const sourceAuth = path.join(codexHomeFrom(sourceEnv), "auth.json");
  let handle;
  try {
    const pathStat = await fs.lstat(sourceAuth);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("Codex auth.json is not a regular file");
    handle = await fs.open(sourceAuth, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error("Codex auth.json changed before it could be isolated");
    }
    if (openedStat.size > MAX_CODEX_AUTH_BYTES) throw new Error("Codex auth.json is unexpectedly large");
    // Read at most the size captured after the limit check. A plain handle.readFile() would
    // buffer whatever the file grew to at read time, so a concurrent write could exceed the
    // cap before the afterStat identity check below rejects it.
    const expectedSize = openedStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let read = 0;
    while (read < expectedSize) {
      const { bytesRead } = await handle.read(buffer, read, expectedSize - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const afterStat = await handle.stat();
    if (read !== expectedSize || afterStat.size !== expectedSize || afterStat.mtimeMs !== openedStat.mtimeMs) {
      throw new Error("Codex auth.json changed while it was being isolated");
    }
    await fs.writeFile(path.join(isolatedHome, "auth.json"), buffer, { mode: 0o600 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  } finally { await handle?.close().catch(() => {}); }
}

export async function prepareIsolatedCodexHome({ tempDir, cwd, sourceEnv = process.env }) {
  const isolatedHome = path.join(tempDir, "codex-home");
  await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  const projectRoot = await findProjectRoot(cwd);
  const config = isolatedCodexConfig(cwd, projectRoot);
  await fs.writeFile(path.join(isolatedHome, "config.toml"), config, { mode: 0o600 });
  await copyCodexAuth(isolatedHome, sourceEnv);
  return isolatedHome;
}

export async function runCodex({ prompt, config, cwd, onEvent, registerChild }) {
  // Codex has one honest write boundary: run. Validate it before command
  // discovery so a rejected permission can never reach a provider process.
  const permission = config.permission || "read";
  if (!new Set(["read", "chat", "planread", "run"]).has(permission)) throw new Error(`Unsupported Codex permission: ${permission}`);

  // Restrict the client-supplied command to a trusted native Codex executable on the real
  // execution path, not only the diagnostic endpoints. Argument boundaries remain intact.
  const trustedCommand = process.env.AGENT_ROOM_CODEX_COMMAND || "";
  const requestedCommand = config.command || trustedCommand || "codex";
  const model = validateOption(config.model || "", "Codex model");
  const effort = validateOption(config.effort || "high", "Codex effort", { allowEmpty: false });
  if (!new Set(["minimal", "low", "medium", "high", "xhigh"]).has(effort)) {
    throw new Error(`Unsupported Codex effort: ${effort}`);
  }

  // Default "read" is read-only (planning/review). "chat" is also read-only
  // with web search enabled. Executor run mode gets workspace-write.
  const sandbox = permission === "run" ? "workspace-write" : "read-only";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-codex-"));
  const outputPath = path.join(tempDir, "final.txt");

  let sessionId = null;
  let errorMessage = null;
  let processResult;
  let finalText = "";
  let outputTruncated = false;
  const startedAt = Date.now();
  try {
    const codexHome = await prepareIsolatedCodexHome({ tempDir, cwd });
    const args = [
      "exec",
      "--json",
      "--sandbox", sandbox,
      "--skip-git-repo-check",
      "-c", `model_reasoning_effort=${effort}`,
      ...codexSecurityOverrides(permission),
      "--output-last-message", outputPath,
    ];
    if (model) args.push("--model", model);
    args.push("-");
    // Resolve + fingerprint-verify the trusted executable as the LAST step before spawn so the
    // check-to-exec TOCTOU window stays minimal. The isolated-home prep above performs several
    // awaits, so resolving earlier would leave a real multi-syscall window on every Codex turn
    // (the accepted-residual note in process.js relies on the resolved path being spawned at once).
    const command = await resolveAllowedCommand(requestedCommand, new Set(["codex"]), { trustedPaths: [trustedCommand, approvedProviderCommand("codex")] });
    processResult = await runProcess({
      command,
      args,
      input: prompt,
      cwd,
      env: {
        CODEX_HOME: codexHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      envPolicy: "agent",
      timeoutMs: agentTimeoutMs(config.timeoutMs),
      containTree: true,
      registerChild,
      onStdoutLine(line) {
        try {
          const parsed = JSON.parse(line);
          sessionId ||= extractSessionId(parsed);
          const type = String(parsed.type || "");
          if (type === "error" || type === "turn.failed") errorMessage = extractCodexError(parsed) || errorMessage;
          const activity = extractActivity(parsed);
          if (activity) onEvent?.(activity);
        } catch {
          if (line.trim()) onEvent?.({ kind: "activity", text: line.slice(0, 240) });
        }
      },
      onStderrLine(line) {
        if (line.trim()) onEvent?.({ kind: "stderr", text: line.slice(0, 500) });
      },
    });
    try {
      const output = await readTextFileCapped(outputPath);
      finalText = output.text.trim();
      outputTruncated = output.truncated;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const durationMs = Date.now() - startedAt;
  const firstLine = (text) => String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const meta = { model: model || "(default)", effort, exitCode: processResult.code, durationMs };

  if (processResult.code !== 0 || errorMessage) {
    const message = errorMessage || firstLine(processResult.stderr) || `Codex exited with code ${processResult.code}`;
    const error = new Error(message);
    error.partial = finalText || "";
    error.outputTruncated = outputTruncated || processResult.stdoutTruncated;
    error.technical = redact([`exitCode=${processResult.code}`, (processResult.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n")].filter(Boolean).join("\n")).slice(0, 4000);
    Object.assign(error, meta);
    throw error;
  }
  // No raw-stdout fallback: the final answer comes only from Codex's --output-last-message
  // file. Raw stdout is the JSON event stream (can carry reasoning) — never surface it.
  if (!finalText) {
    const error = new Error("Codex completed without a final response");
    Object.assign(error, meta);
    throw error;
  }
  return { text: finalText, sessionId, outputTruncated, ...meta };
}

export async function discoverCodexModels({ command = "codex" } = {}) {
  const trustedCommand = process.env.AGENT_ROOM_CODEX_COMMAND || "";
  const resolvedCommand = await resolveAllowedCommand(command, new Set(["codex"]), { trustedPaths: [trustedCommand, approvedProviderCommand("codex")] });
  const result = await runProcess({ command: resolvedCommand, args: ["debug", "models"], timeoutMs: 12000, containTree: true });
  if (result.code !== 0) throw new Error(result.stderr || "Unable to read Codex model catalog");
  const text = result.stdout.trim();
  const candidates = new Set();
  try {
    const parsed = JSON.parse(text);
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["slug", "id", "model", "name"].includes(key) && typeof child === "string" && /gpt|codex|o\d/i.test(child)) {
          candidates.add(child);
        }
        walk(child);
      }
    };
    walk(parsed);
  } catch {
    for (const match of text.matchAll(/["']?((?:gpt|codex|o\d)[a-zA-Z0-9._-]*)["']?/g)) candidates.add(match[1]);
  }
  return [...candidates].sort();
}
