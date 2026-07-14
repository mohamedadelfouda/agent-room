import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, saveSession, getSession, addMessage } from "../../server/store.js";

const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/sessions");
const cleanup = (id) => rm(join(sessionsDir, `${id}.json`), { force: true }).catch(() => {});

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
