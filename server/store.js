import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

async function ensureDirs() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session id");
  return path.join(SESSIONS_DIR, `${id}.json`);
}

async function doWrite(filePath, data) {
  // Random temp name (not pid+Date.now(), which collides when two writes land in the same
  // millisecond in this process → a torn/half-written file). Write then atomic rename.
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    // On success the rename already consumed tempPath (rm is a no-op / ENOENT); on a
    // writeFile/rename failure this removes the leftover so temp files don't accumulate.
    // The original error still propagates.
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

// Serialize async operations per file so concurrent saves — and full read-modify-write
// sequences — for the same session run in call order and never interleave. Ops run in call
// order; the chain survives a failing op so later waiters still proceed.
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
  const files = await fs.readdir(SESSIONS_DIR);
  const sessions = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(SESSIONS_DIR, file), "utf8");
      const session = JSON.parse(raw);
      sessions.push({
        id: session.id,
        title: session.title,
        status: session.status,
        mode: session.mode,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
      });
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
  return ROOT;
}
