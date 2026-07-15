import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = process.env.AGENT_ROOM_RUNTIME_DIR ? path.resolve(process.env.AGENT_ROOM_RUNTIME_DIR) : ROOT;
const DATA_DIR = path.join(RUNTIME_ROOT, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const SCRATCH_WORKSPACE_DIR = path.join(RUNTIME_ROOT, "workspace");
const MAX_SESSION_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 100000;
const MAX_DECISIONS = 200;
const MAX_EXECUTIONS = 50;
const MAX_CONNECTOR_ACTIONS = 100;
const MAX_SESSION_BYTES = 24 * 1024 * 1024;
const TERMINAL_EXECUTION_STATUSES = new Set(["merged", "pr_opened", "rejected", "blocked_secret"]);

function executionNeedsRecovery(record) {
  return !TERMINAL_EXECUTION_STATUSES.has(record.status) || record.cleanupPending !== false || !record.cleanupCompletedAt;
}

function boundedText(value, max = MAX_MESSAGE_CHARS) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n…[stored content truncated]`;
}

function boundedJson(value, max, fallback) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return value;
    if (serialized.length <= max) return value;
    return fallback(serialized.slice(0, max));
  } catch {
    return fallback("");
  }
}

function boundExecution(record) {
  const reviewValue = boundedJson(record.review, 70000, (preview) => ({ text: preview, truncated: true }));
  const review = reviewValue ? { ...reviewValue, text: boundedText(reviewValue.text, 50000) } : reviewValue;
  const diff = record.diff ? {
    ...record.diff,
    files: boundedText(record.diff.files, 50000),
    stat: boundedText(record.diff.stat, 20000),
    patch: boundedText(record.diff.patch, 80000),
  } : record.diff;
  return {
    ...record,
    task: boundedText(record.task, 30000),
    executorText: boundedText(record.executorText, 50000),
    executorMeta: boundedJson(record.executorMeta, 20000, (preview) => ({ truncated: true, preview })),
    worktree: boundedJson(record.worktree, 30000, () => ({ path: boundedText(record.worktree?.path, 4000), branch: boundedText(record.worktree?.branch, 1000), baseSha: record.worktree?.baseSha, approval: record.worktree?.approval })),
    cleanupErrors: Array.isArray(record.cleanupErrors) ? record.cleanupErrors.slice(0, 10).map((error) => boundedText(error, 2000)) : record.cleanupErrors,
    review,
    diff,
    secretFindings: Array.isArray(record.secretFindings)
      ? record.secretFindings.slice(0, 200).map((finding) => ({
        ...finding,
        path: boundedText(finding.path, 2000),
        rule: boundedText(finding.rule, 500),
      }))
      : record.secretFindings,
  };
}

function boundConnectorAction(record) {
  const active = ["pending", "executing_unknown"].includes(record.status);
  const boundedInput = active ? record.input : boundedJson(record.input, 65536, (preview) => ({ truncated: true, preview }));
  return {
    ...record,
    input: boundedInput,
    result: boundedText(record.result, 50000),
    error: boundedText(record.error, 4000),
  };
}

function retainTerminalHistory(records, terminalLimit, isActionable) {
  const terminal = records.filter((record) => !isActionable(record)).slice(-terminalLimit);
  const keep = new Set(terminal);
  return records.filter((record) => isActionable(record) || keep.has(record));
}

function boundSession(session) {
  if (Array.isArray(session.messages)) {
    session.messages = session.messages.slice(-MAX_SESSION_MESSAGES).map((message) => ({
      ...message,
      content: boundedText(message.content, 50000),
      meta: boundedJson(message.meta, 20000, (preview) => ({ truncated: true, preview })),
      control: boundedJson(message.control, 10000, (preview) => ({ truncated: true, preview })),
    }));
  }
  if (Array.isArray(session.decisions)) {
    session.decisions = session.decisions.slice(-MAX_DECISIONS).map((decision) => ({
      ...decision,
      reason: boundedText(decision.reason, 10000),
      metadata: boundedJson(decision.metadata, 10000, (preview) => ({ truncated: true, preview })),
    }));
  }
  if (Array.isArray(session.executions)) {
    session.executions = retainTerminalHistory(session.executions, MAX_EXECUTIONS, executionNeedsRecovery).map(boundExecution);
  }
  if (Array.isArray(session.connectorActions)) {
    session.connectorActions = retainTerminalHistory(
      session.connectorActions,
      MAX_CONNECTOR_ACTIONS,
      (record) => ["pending", "executing_unknown"].includes(record.status),
    ).map(boundConnectorAction);
  }
  session.settings = boundedJson(session.settings, 100000, (preview) => ({ truncated: true, preview }));
  session.connectors = boundedJson(session.connectors, 50000, (preview) => ({ truncated: true, preview }));
  if (Buffer.byteLength(JSON.stringify(session, null, 2), "utf8") > MAX_SESSION_BYTES) {
    if (Array.isArray(session.messages)) session.messages = session.messages.map((message) => ({
      ...message,
      content: boundedText(message.content, 10000),
      meta: boundedJson(message.meta, 5000, (preview) => ({ truncated: true, preview })),
      control: boundedJson(message.control, 2000, (preview) => ({ truncated: true, preview })),
    }));
    if (Array.isArray(session.decisions)) session.decisions = session.decisions.slice(-100).map((decision) => ({ ...decision, reason: boundedText(decision.reason, 2000), metadata: boundedJson(decision.metadata, 2000, (preview) => ({ truncated: true, preview })) }));
    if (Array.isArray(session.executions)) {
      session.executions = retainTerminalHistory(session.executions, 10, executionNeedsRecovery).map((record) => ({
        ...record,
        task: boundedText(record.task, 10000),
        executorText: boundedText(record.executorText, 15000),
        review: record.review ? { ...record.review, text: boundedText(record.review.text, 15000) } : record.review,
        diff: record.diff ? { ...record.diff, files: boundedText(record.diff.files, 10000), stat: boundedText(record.diff.stat, 5000), patch: boundedText(record.diff.patch, 20000) } : record.diff,
      }));
    }
    if (Array.isArray(session.connectorActions)) {
      session.connectorActions = retainTerminalHistory(session.connectorActions, 20, (record) => ["pending", "executing_unknown"].includes(record.status)).map((record) => ({ ...record, result: boundedText(record.result, 10000) }));
    }
    if (Array.isArray(session.messages)) session.messages = session.messages.slice(-100);
  }
  const storedBytes = Buffer.byteLength(JSON.stringify(session, null, 2), "utf8");
  if (storedBytes > MAX_SESSION_BYTES) {
    throw new Error(`Session exceeds the ${MAX_SESSION_BYTES / (1024 * 1024)} MiB storage limit; resolve pending actions or start a new session`);
  }
  return session;
}

function sessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    mode: session.mode,
    updatedAt: session.updatedAt,
    messageCount: session.messages?.length ?? 0,
    hasExecutions: Array.isArray(session.executions) && session.executions.length > 0,
    hasRecoverableExecutions: Array.isArray(session.executions) && session.executions.some(executionNeedsRecovery),
    projectPath: boundedText(session.project?.path, 4000),
  };
}

async function ensureDirs() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session id");
  return path.join(SESSIONS_DIR, `${id}.json`);
}

async function replaceJson(filePath, data) {
  // Random temp name (not pid+Date.now(), which collides when two writes land in the same
  // millisecond in this process → a torn/half-written file). Write then atomic rename.
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    // Windows can transiently deny a replace while antivirus/indexing has the destination
    // open. Retrying the same atomic rename preserves the old-or-new guarantee; deleting the
    // destination first would introduce a window where the session does not exist.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tempPath, filePath);
        break;
      } catch (error) {
        const retryable = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
        if (!retryable || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
  } finally {
    // On success the rename already consumed tempPath (rm is a no-op / ENOENT); on a
    // writeFile/rename failure this removes the leftover so temp files don't accumulate.
    // The original error still propagates.
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function summaryPath(filePath) {
  return filePath.replace(/\.json$/i, ".summary.json");
}

async function doWrite(filePath, data) {
  boundSession(data);
  await replaceJson(filePath, data);
  // The transcript is the transaction. The compact sidebar summary is only a
  // cache: a cache write failure must never make callers retry a durable action.
  await replaceJson(summaryPath(filePath), sessionSummary(data)).catch(() => {});
}

// Serialize operations per session file inside the host process. Callers that need an atomic
// read-modify-write transition must use mutateSession; saveSession only serializes its write.
const writeLocks = new Map();
function runExclusive(filePath, task) {
  const prev = writeLocks.get(filePath) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(() => {}, () => {}); // non-rejecting, so one failure can't stall the chain
  writeLocks.set(filePath, tail);
  tail.then(() => { if (writeLocks.get(filePath) === tail) writeLocks.delete(filePath); });
  return run;
}
async function atomicWrite(filePath, data) {
  return runExclusive(filePath, () => doWrite(filePath, data));
}

export async function listSessions() {
  await ensureDirs();
  const files = (await fs.readdir(SESSIONS_DIR)).filter((file) => file.endsWith(".json") && !file.endsWith(".summary.json"));
  const sessions = [];
  for (const file of files) {
    try {
      const mainPath = path.join(SESSIONS_DIR, file);
      let summary;
      try {
        const cachedPath = summaryPath(mainPath);
        const [mainStat, summaryStat] = await Promise.all([fs.stat(mainPath, { bigint: true }), fs.stat(cachedPath, { bigint: true })]);
        if (summaryStat.mtimeNs <= mainStat.mtimeNs) throw new Error("stale summary cache");
        summary = JSON.parse(await fs.readFile(cachedPath, "utf8"));
      }
      catch {
        const session = JSON.parse(await fs.readFile(mainPath, "utf8"));
        summary = sessionSummary(session);
        await replaceJson(summaryPath(mainPath), summary).catch(() => {});
      }
      sessions.push(summary);
    } catch {
      // Ignore a partially copied/corrupt file and leave it for manual recovery.
    }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function createSession(title = "جلسة جديدة") {
  await ensureDirs();
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    title: String(title || "جلسة جديدة").trim().slice(0, 160),
    status: "idle",
    mode: "collaboration",
    createdAt: now,
    updatedAt: now,
    messages: [],
    decisions: [],
    settings: {},
  };
  await atomicWrite(sessionPath(session.id), session);
  return session;
}

export async function getSession(id) {
  await ensureDirs();
  const raw = await fs.readFile(sessionPath(id), "utf8");
  return JSON.parse(raw);
}

export async function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  await atomicWrite(sessionPath(session.id), session);
  return session;
}

export async function addMessage(id, message) {
  const filePath = sessionPath(id);
  const saved = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...message,
  };
  // Serialize the whole load→append→save under the per-session lock so two concurrent
  // addMessage calls can't both read the same state and clobber each other's message.
  // (Use doWrite, not saveSession, inside the lock to avoid re-entering runExclusive.)
  await runExclusive(filePath, async () => {
    const session = await getSession(id);
    session.messages.push(saved);
    session.updatedAt = new Date().toISOString();
    await doWrite(filePath, session);
  });
  return saved;
}

export function rootPath() {
  return RUNTIME_ROOT;
}

export async function scratchWorkspacePath() {
  await fs.mkdir(SCRATCH_WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(SCRATCH_WORKSPACE_DIR, 0o700);
  return SCRATCH_WORKSPACE_DIR;
}

export async function mutateSession(id, mutate) {
  const filePath = sessionPath(id);
  return runExclusive(filePath, async () => {
    await ensureDirs();
    const session = JSON.parse(await fs.readFile(filePath, "utf8"));
    const result = await mutate(session);
    session.updatedAt = new Date().toISOString();
    await doWrite(filePath, session);
    return result === undefined ? session : result;
  });
}

export async function renameSession(id, title) {
  const next = String(title ?? "").trim().slice(0, 160);
  if (!next) {
    const error = new Error("Title is required");
    error.code = "title_required";
    throw error;
  }
  return mutateSession(id, (session) => {
    session.title = next;
    return { id: session.id, title: session.title };
  });
}

export async function deleteSession(id, { isBusy } = {}) {
  const filePath = sessionPath(id);
  return runExclusive(filePath, async () => {
    let session;
    try {
      session = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        const missing = new Error("Session not found");
        missing.code = "ENOENT";
        throw missing;
      }
      throw error;
    }
    if (typeof isBusy === "function" && isBusy()) {
      const error = new Error("Session is already busy");
      error.code = "session_busy";
      throw error;
    }
    if (Array.isArray(session.executions) && session.executions.some(executionNeedsRecovery)) {
      const error = new Error("Resolve pending execution decisions before deleting the session");
      error.code = "pending_execution_decisions";
      throw error;
    }
    if (Array.isArray(session.connectorActions) && session.connectorActions.some((record) => ["pending", "executing_unknown"].includes(record.status))) {
      const error = new Error("Resolve pending connector actions before deleting the session");
      error.code = "pending_execution_decisions";
      throw error;
    }
    await fs.rm(filePath, { force: true });
    await fs.rm(summaryPath(filePath), { force: true });
    return { id: session.id, deleted: true };
  });
}
