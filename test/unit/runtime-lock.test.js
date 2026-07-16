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

test("a lock held by a live but unverifiable PID is recovered once its heartbeat goes stale", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-reused-pid-lock-"));
  const lockPath = path.join(root, ".agent-room-runtime.lock");
  // A live PID (our own) with no cross-platform ownership proof — exactly the reused-PID case on
  // Windows/macOS, where the OS can hand a crashed server's PID to an unrelated live process.
  await fs.writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    processStartedAt: new Date().toISOString(),
  }), "utf8");
  try {
    // A fresh heartbeat (mtime) means a real owner is alive: the lock must not be stealable.
    await assert.rejects(() => acquireRuntimeLock(root), (error) => error.code === "runtime_locked");
    // Age the heartbeat past the staleness window: a stranger PID must no longer wedge the folder.
    const stale = new Date(Date.now() - 120000);
    await fs.utimes(lockPath, stale, stale);
    const recovered = await acquireRuntimeLock(root, { staleConfirmMs: 50 });
    assert.equal(recovered.owner.pid, process.pid);
    assert.equal(await recovered.release(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a stale-looking lock whose owner refreshes its heartbeat during the confirm window is not stolen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-room-resume-lock-"));
  const lockPath = path.join(root, ".agent-room-runtime.lock");
  const stale = new Date(Date.now() - 120000);
  // A live PID (ours) with a momentarily stale heartbeat — e.g. an owner just resumed from sleep.
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }), "utf8");
  await fs.utimes(lockPath, stale, stale);
  try {
    const acquire = acquireRuntimeLock(root, { staleConfirmMs: 600 });
    // The owner's heartbeat refreshes the lock mtime partway through the confirm window.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const now = new Date();
    await fs.utimes(lockPath, now, now);
    await assert.rejects(() => acquire, (error) => error.code === "runtime_locked");
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
