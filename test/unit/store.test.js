import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, saveSession, getSession } from "../../server/store.js";

const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/sessions");

test("concurrent saves of one session never corrupt the file", async () => {
  const s = await createSession("concurrency-test");
  try {
    // Fire many overlapping saves with different content in the same tick.
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        saveSession({ ...s, messages: Array.from({ length: i }, (_, j) => ({ id: `${j}`, content: "x" })) })
      )
    );
    const loaded = await getSession(s.id); // must parse — a torn write would throw here
    assert.equal(loaded.id, s.id);
    assert.ok(Array.isArray(loaded.messages));
  } finally {
    await rm(join(sessionsDir, `${s.id}.json`), { force: true }).catch(() => {});
  }
});
