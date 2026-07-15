import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, saveSession, getSession, addMessage, listSessions } from "../../server/store.js";

const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/sessions");
const cleanup = (id) => Promise.all([
  rm(join(sessionsDir, `${id}.json`), { force: true }),
  rm(join(sessionsDir, `${id}.summary.json`), { force: true }),
]).catch(() => {});

test("concurrent saves of one session store one complete payload — never torn or mixed", async () => {
  const s = await createSession("concurrency-test");
  try {
    // Each save carries a distinct, self-consistent messages array (length i).
    const expected = Array.from({ length: 60 }, (_, i) =>
      Array.from({ length: i }, (_, j) => ({ id: `${j}`, content: "x" })));
    await Promise.all(expected.map((messages) => saveSession({ ...s, messages })));
    const loaded = await getSession(s.id); // must parse — a torn write would throw here
    assert.equal(loaded.id, s.id);
    // The file must hold exactly ONE of the payloads intact — not a truncated or interleaved
    // mix of two writes. Matching by length pins it to a specific complete payload.
    assert.deepEqual(loaded.messages, expected[loaded.messages.length]);
  } finally {
    await cleanup(s.id);
  }
});

test("concurrent addMessage calls on one session don't drop appends", async () => {
  const s = await createSession("addmessage-test");
  try {
    // Without serializing the load→append→save sequence, overlapping addMessage calls would
    // read the same state and clobber each other, losing messages.
    await Promise.all(Array.from({ length: 40 }, (_, i) => addMessage(s.id, { content: `m${i}` })));
    const loaded = await getSession(s.id);
    assert.equal(loaded.messages.length, 40);
    assert.equal(new Set(loaded.messages.map((m) => m.content)).size, 40); // all distinct, none lost
  } finally {
    await cleanup(s.id);
  }
});

test("session listing reads compact summaries instead of full transcript payloads", async () => {
  const session = await createSession("summary-index-test");
  try {
    const mainPath = join(sessionsDir, `${session.id}.json`);
    await writeFile(mainPath, "not valid JSON", "utf8");
    // Keep the cached summary newer than the deliberately damaged transcript.
    // A newer transcript must be parsed instead, so stale summaries cannot hide data.
    await utimes(mainPath, new Date(0), new Date(0));
    const summaries = await listSessions();
    assert.equal(summaries.find((item) => item.id === session.id)?.title, "summary-index-test");
  } finally { await cleanup(session.id); }
});

test("session listing treats equal summary and transcript mtimes as stale", async () => {
  const session = await createSession("equal-mtime-before");
  try {
    const mainPath = join(sessionsDir, `${session.id}.json`);
    const summaryPath = join(sessionsDir, `${session.id}.summary.json`);
    const stored = JSON.parse(await readFile(mainPath, "utf8"));
    stored.title = "equal-mtime-after";
    await writeFile(mainPath, JSON.stringify(stored, null, 2), "utf8");
    const sameTime = new Date("2020-01-01T00:00:00.000Z");
    await Promise.all([utimes(mainPath, sameTime, sameTime), utimes(summaryPath, sameTime, sameTime)]);

    const summaries = await listSessions();
    assert.equal(summaries.find((item) => item.id === session.id)?.title, "equal-mtime-after");
  } finally { await cleanup(session.id); }
});

test("session persistence enforces the 24 MiB UTF-8 hard limit", async () => {
  const session = await createSession("byte-budget-test");
  try {
    session.messages = Array.from({ length: 200 }, (_, index) => ({ id: String(index), content: "😀".repeat(50000) }));
    await saveSession(session);
    const info = await stat(join(sessionsDir, `${session.id}.json`));
    assert.ok(info.size <= 24 * 1024 * 1024, `stored session was ${info.size} bytes`);
  } finally { await cleanup(session.id); }
});

test("history retention never drops a terminal execution whose cleanup is pending", async () => {
  const session = await createSession("cleanup-retention-test");
  try {
    const completedAt = new Date().toISOString();
    session.executions = [
      { taskId: "pending-cleanup", status: "merged", cleanupPending: true, worktree: { path: "pending", branch: "agent/codex/pending" } },
      ...Array.from({ length: 60 }, (_, index) => ({ taskId: `clean-${index}`, status: "merged", cleanupPending: false, cleanupCompletedAt: completedAt })),
    ];
    await saveSession(session);
    const saved = await getSession(session.id);
    assert.ok(saved.executions.some((record) => record.taskId === "pending-cleanup"));
    assert.equal(saved.executions.filter((record) => record.taskId.startsWith("clean-")).length, 50);
  } finally { await cleanup(session.id); }
});
