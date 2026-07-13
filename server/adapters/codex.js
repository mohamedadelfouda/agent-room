import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, validateOption } from "../process.js";
import { redact } from "../logger.js";

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

export async function runCodex({ prompt, config, cwd, onEvent, registerChild }) {
  const command = validateOption(config.command || "codex", "Codex command", { allowEmpty: false });
  const model = validateOption(config.model || "", "Codex model");
  const effort = validateOption(config.effort || "high", "Codex effort", { allowEmpty: false });
  if (!new Set(["minimal", "low", "medium", "high", "xhigh"]).has(effort)) {
    throw new Error(`Unsupported Codex effort: ${effort}`);
  }

  // Permission level -> sandbox. Default "read" = read-only (planning/review).
  // "chat" is also read-only but with web search enabled (general chat that can look
  // things up). Executor gets workspace-write (edit/run) or danger-full-access (full).
  const permission = config.permission || "read";
  const sandbox = (permission === "read" || permission === "chat") ? "read-only" : permission === "full" ? "danger-full-access" : "workspace-write";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-codex-"));
  const outputPath = path.join(tempDir, "final.txt");
  const args = [
    "exec",
    "--json",
    "--sandbox", sandbox,
    "--skip-git-repo-check",
    "-c", `model_reasoning_effort=${effort}`,
    "--output-last-message", outputPath,
  ];
  if (permission === "chat") args.push("--enable", "web_search_request");
  if (model) args.push("--model", model);
  args.push("-");

  let sessionId = null;
  let errorMessage = null;
  const rawEvents = [];
  const startedAt = Date.now();
  const result = await runProcess({
    command,
    args,
    input: prompt,
    cwd,
    registerChild,
    onStdoutLine(line) {
      try {
        const parsed = JSON.parse(line);
        rawEvents.push(parsed);
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

  let finalText = "";
  try { finalText = (await fs.readFile(outputPath, "utf8")).trim(); } catch {}
  await fs.rm(tempDir, { recursive: true, force: true });

  const durationMs = Date.now() - startedAt;
  const firstLine = (text) => String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const meta = { model: model || "(default)", effort, exitCode: result.code, durationMs };

  if (result.code !== 0 || errorMessage) {
    const message = errorMessage || firstLine(result.stderr) || `Codex exited with code ${result.code}`;
    const error = new Error(message);
    error.partial = finalText || "";
    error.technical = redact([`exitCode=${result.code}`, (result.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n")].filter(Boolean).join("\n")).slice(0, 4000);
    Object.assign(error, meta);
    throw error;
  }
  if (!finalText) finalText = result.stdout.trim();
  if (!finalText) {
    const error = new Error("Codex completed without a final response");
    Object.assign(error, meta);
    throw error;
  }
  return { text: finalText, sessionId, rawEvents, ...meta };
}

export async function discoverCodexModels({ command = "codex" } = {}) {
  const safeCommand = validateOption(command, "Codex command", { allowEmpty: false });
  const result = await runProcess({ command: safeCommand, args: ["debug", "models"], timeoutMs: 12000 });
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
