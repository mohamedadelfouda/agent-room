import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const LOCK_FILE_NAME = ".agent-room-runtime.lock";
const HEARTBEAT_INTERVAL_MS = 5000;
const CORRUPT_LOCK_STALE_MS = 30000;

function runtimeLockError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.apiCode = code;
  error.apiStatus = 409;
  return error;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function linuxProcessStartToken(pid) {
  if (process.platform !== "linux") return "";
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const closeParen = stat.lastIndexOf(")");
  const token = closeParen === -1 ? "" : stat.slice(closeParen + 2).split(" ")[19] || "";
  if (!token) throw runtimeLockError("runtime_lock_uncertain", "Runtime lock owner identity could not be verified");
  return token;
}

async function processOwnsRecordedLock(owner) {
  if (!processIsAlive(owner?.pid)) return false;
  if (!owner.processStartToken || process.platform !== "linux") return true;
  try {
    return await linuxProcessStartToken(owner.pid) === owner.processStartToken;
  } catch (error) {
    if (error?.code === "ENOENT" && !processIsAlive(owner.pid)) return false;
    throw runtimeLockError("runtime_lock_uncertain", "Runtime lock owner identity could not be verified");
  }
}

async function readLock(lockPath) {
  const [text, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  return { owner: JSON.parse(text), stat };
}

async function createOwnedLock(lockPath, { onOwnershipLost, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const processStartToken = await linuxProcessStartToken(process.pid).catch(() => "");
  const owner = {
    pid: process.pid,
    token,
    createdAt: now,
    processStartedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    ...(processStartToken ? { processStartToken } : {}),
  };
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }

  let released = false;
  let heartbeatRunning = false;
  let ownershipLossReported = false;
  const health = { healthy: true, ownershipLost: false, consecutiveFailures: 0, lastHeartbeatAt: null, lastErrorAt: null, lastErrorCategory: "", released: false };
  const heartbeat = setInterval(async () => {
    if (released || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const current = await readLock(lockPath);
      if (current.owner.token !== token) {
        const error = new Error("Runtime lock ownership changed");
        error.code = "runtime_lock_ownership_lost";
        throw error;
      }
      const timestamp = new Date();
      await fs.utimes(lockPath, timestamp, timestamp);
      health.healthy = true;
      health.consecutiveFailures = 0;
      health.lastHeartbeatAt = timestamp.toISOString();
    } catch (error) {
      health.healthy = false;
      health.consecutiveFailures += 1;
      health.lastErrorAt = new Date().toISOString();
      health.lastErrorCategory = String(error?.code || error?.name || "runtime_lock_heartbeat_failed").slice(0, 80);
      const confirmedLoss = ["ENOENT", "runtime_lock_ownership_lost"].includes(error?.code) || error instanceof SyntaxError;
      if (!ownershipLossReported && (confirmedLoss || health.consecutiveFailures >= 3)) {
        ownershipLossReported = true;
        health.ownershipLost = true;
        clearInterval(heartbeat);
        onOwnershipLost?.(error);
      }
    }
    finally { heartbeatRunning = false; }
  }, Math.max(10, heartbeatIntervalMs));
  heartbeat.unref?.();

  return {
    owner,
    lockPath,
    health() { return { ...health }; },
    async release() {
      if (released) return false;
      released = true;
      health.released = true;
      clearInterval(heartbeat);
      try {
        const current = await readLock(lockPath);
        if (current.owner.token !== token) return false;
        await fs.rm(lockPath, { force: true });
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

export async function acquireRuntimeLock(runtimeRoot, options = {}) {
  const requestedRoot = String(runtimeRoot || "").trim();
  if (!requestedRoot) throw runtimeLockError("runtime_lock_invalid", "Runtime directory is required");
  const root = path.resolve(requestedRoot);
  await fs.mkdir(root, { recursive: true });
  const lockPath = path.join(root, LOCK_FILE_NAME);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await createOwnedLock(lockPath, options);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let observed;
    try {
      observed = await readLock(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      const stat = await fs.stat(lockPath).catch(() => null);
      const recent = stat && Date.now() - stat.mtimeMs < CORRUPT_LOCK_STALE_MS;
      if (recent) throw runtimeLockError("runtime_lock_uncertain", "Runtime lock is incomplete; retry shortly");
      observed = { owner: null, stat };
    }

    if (observed.owner && await processOwnsRecordedLock(observed.owner)) {
      throw runtimeLockError("runtime_locked", "Another Agent Room server is using this data folder");
    }

    const stalePath = `${lockPath}.${crypto.randomUUID()}.stale`;
    try {
      await fs.rename(lockPath, stalePath);
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes(error?.code)) continue;
      throw error;
    }
    try {
      return await createOwnedLock(lockPath, options);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      await fs.rm(stalePath, { force: true }).catch(() => {});
    }
  }
  throw runtimeLockError("runtime_locked", "Another Agent Room server acquired this data folder");
}
