import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireRuntimeLock } from "../../server/runtime-lock.js";

test("a live runtime lock cannot be stolen and only its owner can release it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-runtime-lock-"));
  const first = await acquireRuntimeLock(root);
  try {
    await assert.rejects(() => acquireRuntimeLock(root), (error) => error.code === "runtime_locked");
    assert.equal(await first.release(), true);
    const second = await acquireRuntimeLock(root);
    assert.equal(await second.release(), true);
  } finally {
    await first.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a lock whose recorded process is gone is recovered atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-stale-lock-"));
  const lockPath = path.join(root, ".agent-room-runtime.lock");
  await fs.writeFile(lockPath, JSON.stringify({
    pid: 2147483647,
    token: crypto.randomUUID(),
    createdAt: "2025-01-01T00:00:00.000Z",
    processStartedAt: "2025-01-01T00:00:00.000Z",
  }), "utf8");
  try {
    const recovered = await acquireRuntimeLock(root);
    assert.equal(recovered.owner.pid, process.pid);
    assert.equal(await recovered.release(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("losing runtime-lock ownership notifies the server before another writer can continue unnoticed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-lost-lock-"));
  let notifyOwnershipLost;
  const ownershipLost = new Promise((resolve) => { notifyOwnershipLost = resolve; });
  const lock = await acquireRuntimeLock(root, {
    heartbeatIntervalMs: 20,
    onOwnershipLost: notifyOwnershipLost,
  });
  try {
    await fs.writeFile(lock.lockPath, JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }), "utf8");
    let timeoutHandle;
    try {
      await Promise.race([
        ownershipLost,
        new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error("Runtime lock loss was not reported")), 1000); }),
      ]);
    } finally { clearTimeout(timeoutHandle); }
    assert.equal(lock.health().ownershipLost, true);
    assert.equal(await lock.release(), false);
  } finally {
    await lock.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});
