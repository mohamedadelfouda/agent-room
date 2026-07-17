import { runProcess, validateOption } from "../process.js";
import { redact } from "../logger.js";
import { agentTimeoutMs } from "../output-limits.js";
import { buildCursorLaunchDescriptor } from "../providers/cursor-launch.js";

// Cursor (cursor-agent) reviewer adapter.
//
// Cursor is REVIEW-ONLY in Agent Room (capabilities.executeModes []): its OS sandbox — the only thing that
// could contain writes/network for execution — exists on macOS/Linux but NOT Windows, where cursor-agent
// FAILS CLOSED on `--sandbox enabled`. Review containment does not need the OS sandbox: it comes from
// `--mode plan` (read-only; verified to write nothing) plus the disposable clone the orchestrator passes as
// cwd. Cursor launches through a trusted descriptor — a fixed node + index.js chain, containment-checked
// inside the trusted version dir and fingerprinted fresh at launch (never a bare `node` on the process
// allowlist) — always with a sanitized env (no NODE_OPTIONS) and never `--force`/`--yolo`.
//
// NOT YET REGISTRY-WIRED. This implements the launch + review parsing, but still lacks the config-isolation,
// untrusted-project-settings, and network-denial layers (configIsolated / projectSettingsUntrustedDisabled /
// networkDenied) that deriveCursorQualification requires for reviewQualified: a disposable CURSOR_CONFIG_DIR
// with project trust + MCPs forced off, plus a network-denial mechanism. Those must land before Cursor is
// added to the provider registry.

const REVIEW_PERMISSIONS = new Set(["read", "chat", "planread"]);

// Build the review argv. Pure, so the argv boundary (entry point first, plan mode, never --force) is
// directly testable. Request args only ever append AFTER the descriptor's fixed prefix ([entryPoint]).
export function buildCursorReviewArgs({ descriptor, model, platform = process.platform }) {
  // Windows has no OS sandbox (allowlist mode only); macOS/Linux run the reviewer OS-sandboxed.
  const sandbox = platform === "win32" ? "disabled" : "enabled";
  const args = [
    ...descriptor.fixedPrefixArgs, // exactly [entryPoint] — validated; nothing may precede it
    "--print",
    "--output-format", "json",
    "--mode", "plan",              // read-only planning; never --force / --yolo
    "--sandbox", sandbox,
    "--trust",                     // trust the (disposable clone) workspace in headless mode
  ];
  if (model) {
    // A leading dash would let a model value pose as its own flag (e.g. --yolo, cursor-agent's apply mode).
    // Reject it, and emit the value as a single --model=<value> token so the parser can never split it into
    // a separate flag — a bogus value then fails closed as an unknown model instead of enabling anything.
    if (model.startsWith("-")) throw new Error("Cursor model must not start with '-'");
    args.push(`--model=${model}`);
  }
  return args;
}

// cursor-agent --output-format json prints a single result object. Parse it defensively (tolerate a stray
// leading line) and return null when nothing parseable is present, so callers fail closed.
export function parseCursorResult(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  // Only accept a real result envelope, so a coincidental JSON-shaped line can't pose as the review.
  const envelope = (obj) => (obj && typeof obj === "object" && ("result" in obj || "is_error" in obj || "type" in obj) ? obj : null);
  try { const whole = envelope(JSON.parse(text)); if (whole) return whole; } catch {}
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { const obj = envelope(JSON.parse(lines[i])); if (obj) return obj; } catch {}
  }
  return null;
}

// Parse `cursor-agent --list-models` output ("<id> - <label>" per line) into sorted unique model ids.
export function parseCursorModels(stdout) {
  const models = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^([a-z0-9][\w.-]*)\s+-\s+/i.exec(line.trim());
    if (match) models.push(match[1]);
  }
  return [...new Set(models)].sort();
}

function cursorErrorMessage(parsed, processResult, stderr) {
  const fromResult = parsed?.is_error && typeof parsed?.result === "string" ? parsed.result : "";
  const firstStderr = stderr.find((line) => line.trim()) || "";
  return (fromResult || firstStderr || `Cursor exited with code ${processResult.code}`).trim();
}

async function resolveDescriptor() {
  // Build + validate from the real install RIGHT before use: the fresh fingerprints are the runtime
  // integrity check, and building last keeps the check-to-exec window minimal.
  const built = await buildCursorLaunchDescriptor({});
  if (!built.ok) throw new Error(`Cursor launch chain unavailable: ${built.reason}`);
  if (!built.validation.valid) throw new Error(`Cursor launch descriptor invalid: ${built.validation.violations.join("; ")}`);
  return built.descriptor;
}

export async function runCursor({ prompt, config, cwd, onEvent, registerChild }) {
  // Reviewer-only: an executor permission must never reach Cursor (it has no qualified write mode).
  const permission = config.permission || "read";
  if (!REVIEW_PERMISSIONS.has(permission)) throw new Error(`Unsupported Cursor permission: ${permission}`);
  const model = validateOption(config.model || "", "Cursor model");

  const descriptor = await resolveDescriptor();
  const args = buildCursorReviewArgs({ descriptor, model });
  const stderr = [];
  const startedAt = Date.now();
  const processResult = await runProcess({
    command: descriptor.executable,
    args,
    input: prompt,               // prompt via stdin — no CLI length limit
    cwd,
    envPolicy: "agent",          // sanitized env: excludes NODE_OPTIONS/NODE_* (the envIsolated layer)
    timeoutMs: agentTimeoutMs(config.timeoutMs),
    containTree: true,           // Stop kills cursor-agent and its whole child tree
    registerChild,
    onStderrLine(line) { if (line.trim()) { stderr.push(line); onEvent?.({ kind: "stderr", text: line.slice(0, 500) }); } },
  });
  const durationMs = Date.now() - startedAt;
  const parsed = parseCursorResult(processResult.stdout);
  const meta = { model: model || "(default)", effort: config.effort || "", exitCode: processResult.code, durationMs };

  if (processResult.code !== 0 || !parsed || parsed.is_error) {
    const error = new Error(cursorErrorMessage(parsed, processResult, stderr));
    error.partial = typeof parsed?.result === "string" ? parsed.result : "";
    error.outputTruncated = Boolean(processResult.stdoutTruncated);
    error.technical = redact([`exitCode=${processResult.code}`, (processResult.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n")].filter(Boolean).join("\n")).slice(0, 4000);
    Object.assign(error, meta);
    throw error;
  }
  const text = String(parsed.result || "").trim();
  if (!text) { const error = new Error("Cursor completed without a review"); Object.assign(error, meta); throw error; }
  return { text, sessionId: parsed.session_id || null, outputTruncated: Boolean(processResult.stdoutTruncated), ...meta };
}

export async function discoverCursorModels() {
  const descriptor = await resolveDescriptor();
  const result = await runProcess({
    command: descriptor.executable,
    args: [...descriptor.fixedPrefixArgs, "--list-models"],
    envPolicy: "agent",
    timeoutMs: 15000,
    containTree: true,
  });
  if (result.code !== 0) throw new Error(redact((result.stderr || "Unable to read Cursor model catalog").split(/\r?\n/)[0]));
  return parseCursorModels(result.stdout);
}
