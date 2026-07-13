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

async function atomicWrite(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
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
  const session = await getSession(id);
  const saved = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...message,
  };
  session.messages.push(saved);
  await saveSession(session);
  return saved;
}

export function rootPath() {
  return ROOT;
}
