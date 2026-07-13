import { runProcess, validateOption } from "../process.js";
import { redact } from "../logger.js";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item.text === "string") return item.text;
    if (item && typeof item.content === "string") return item.content;
    return "";
  }).join("");
}

function parseClaudeLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export async function runClaude({ prompt, config, cwd, onEvent, registerChild }) {
  const command = validateOption(config.command || "claude", "Claude command", { allowEmpty: false });
  const model = validateOption(config.model || "sonnet", "Claude model", { allowEmpty: false });
  const effort = validateOption(config.effort || "high", "Claude effort", { allowEmpty: false });
  if (!new Set(["low", "medium", "high", "xhigh", "max", "ultracode"]).has(effort)) {
    throw new Error(`Unsupported Claude effort: ${effort}`);
  }

  // Permission level controls what the agent may do. Default "read" keeps the safe
  // planning/review behavior (no file writes, no commands). Only an explicitly chosen
  // executor gets write/run permissions — the reviewer always stays "read".
  // "chat" is a general chat that can look things up on the web (WebSearch/WebFetch)
  // and read, but never edit files or run shell commands. --allowedTools only
  // pre-approves (it does not restrict), and --permission-mode auto is permissive,
  // so we also DENY Bash/Edit/Write explicitly — deny rules win, which keeps chat
  // read-only even if a web page it reads tries to trigger a write/command.
  // "planread" lets a planning agent READ the attached project (Read/Grep/Glob) to ground
  // its answer, but never edit, run commands, or search the web.
  const permission = config.permission || "read";
  const permArgs =
    permission === "chat" ? ["--permission-mode", "auto", "--allowedTools", "WebSearch,WebFetch,Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write,NotebookEdit"]
    : permission === "planread" ? ["--permission-mode", "auto", "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch,Task", "--strict-mcp-config"]
    : permission === "edit" ? ["--permission-mode", "acceptEdits", "--allowedTools", "Read Edit Write Grep Glob"]
    : (permission === "run" || permission === "full") ? ["--permission-mode", "bypassPermissions"]
    : ["--disallowedTools", "*"];
  const args = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...permArgs,
    "Use the complete task supplied through standard input. Return only your response for the shared session.",
  ];

  let sessionId = null;
  let finalText = "";
  let streamedText = "";
  let resultError = null;
  const startedAt = Date.now();
  const result = await runProcess({
    command,
    args,
    input: prompt,
    cwd,
    registerChild,
    onStdoutLine(line) {
      const event = parseClaudeLine(line);
      if (!event) {
        if (line.trim()) streamedText += `${line}\n`;
        return;
      }
      sessionId ||= event.session_id || event.sessionId || event.message?.session_id || null;
      if (event.type === "result") {
        if (event.is_error) resultError = typeof event.result === "string" ? event.result : "Claude reported an error";
        else if (typeof event.result === "string") finalText = event.result;
        return;
      }
      const delta = event.delta?.text || event.content_block_delta?.delta?.text || event.message?.delta?.text;
      if (typeof delta === "string" && delta) {
        streamedText += delta;
        onEvent?.({ kind: "delta", text: delta });
        return;
      }
      const messageText = contentText(event.message?.content || event.content);
      if (messageText) {
        finalText = messageText;
      }
      const type = String(event.type || "");
      if (type.includes("error")) onEvent?.({ kind: "error", text: event.error?.message || event.message || type });
      else if (type) onEvent?.({ kind: "activity", text: type });
    },
    onStderrLine(line) {
      if (line.trim()) onEvent?.({ kind: "stderr", text: line.slice(0, 500) });
    },
  });

  const durationMs = Date.now() - startedAt;
  const firstLine = (text) => String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const meta = { model, effort, exitCode: result.code, durationMs };

  if (result.code !== 0 || resultError) {
    const message = resultError || firstLine(result.stderr) || `Claude exited with code ${result.code}`;
    const error = new Error(message);
    // Only the visible text stream is kept as partial — never thinking/reasoning.
    error.partial = String(streamedText || finalText || "").trim();
    // Technical details = exit code + tail of stderr, redacted. Never raw stdout (it carries thinking).
    error.technical = redact([`exitCode=${result.code}`, (result.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n")].filter(Boolean).join("\n")).slice(0, 4000);
    Object.assign(error, meta);
    throw error;
  }
  // No raw-stdout fallback: use only parsed final text or the visible delta stream. Raw
  // stdout is the JSON event stream (can carry thinking) — never surface it as the answer.
  finalText = String(finalText || streamedText).trim();
  if (!finalText) {
    const error = new Error("Claude completed without a final response");
    Object.assign(error, meta);
    throw error;
  }
  return { text: finalText, sessionId, ...meta };
}
