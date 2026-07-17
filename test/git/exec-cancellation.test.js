import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../../server/worktree.js";
import { runExecution } from "../../server/executor.js";
import { runExecuteAndReview, stopExec, isExecuting } from "../../server/exec-orchestrator.js";
import { createSession, getSession, rootPath, saveSession } from "../../server/store.js";
import { projectIdentity } from "../../server/project.js";
import { provider } from "../../server/providers/registry.js";
import { claimSessionActivity } from "../../server/session-activity.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ar-exec-cancel-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "owner@example.com");
  git(dir, "config", "user.name", "Project Owner");
  writeFileSync(join(dir, ".gitignore"), ".agent-workspaces/\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function nextEventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function trustedSession(name, dir) {
  const session = await createSession(name);
  const identity = await projectIdentity(dir);
  session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true, isGit: true, canOpenPr: false };
  await saveSession(session);
  return session;
}

async function cleanupSession(id) {
  const sessions = join(rootPath(), "data", "sessions");
  await Promise.all([
    rm(join(sessions, `${id}.json`), { force: true }),
    rm(join(sessions, `${id}.summary.json`), { force: true }),
  ]);
}

// The workspace root for one executor should hold no leftover task clones after a stop.
function executorWorkspaceCount(dir, agent) {
  const root = join(dir, ".agent-workspaces", agent);
  return existsSync(root) ? readdirSync(root).length : 0;
}

const execRequest = () => ({ executor: "codex", reviewer: "claude", mode: "run", task: "add a feature", agents: {} });

test("createWorktree aborts before cloning when a stop already landed", async () => {
  const dir = repository();
  try {
    await assert.rejects(
      () => createWorktree(dir, "codex", "t-precancel", { isCancelled: () => true }),
      /Execution stopped by user/,
    );
    // The clone must never have started: no workspace tree was created for it.
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop that lands after the clone aborts before the executor runs and cleans up", async (t) => {
  const dir = repository();
  let providerCalled = false;
  // The executor must never launch once a stop is accepted after the clone exists.
  t.mock.method(provider("codex"), "run", async () => {
    providerCalled = true;
    return { text: "must not run", model: "test", durationMs: 1, exitCode: 0 };
  });
  // Report "cancelled" only once the clone directory exists on disk — i.e. after createWorktree's
  // clone step, before the executor is launched. Filesystem-based so it doesn't depend on the exact
  // number of internal cancel checks (which would make the test brittle).
  const cloneExists = () => {
    const agentRoot = join(dir, ".agent-workspaces", "codex");
    if (!existsSync(agentRoot)) return false;
    return readdirSync(agentRoot).some((entry) => existsSync(join(agentRoot, entry, ".git")));
  };

  try {
    await assert.rejects(
      () => runExecution({ projectPath: dir, executor: "codex", mode: "run", task: "add a feature", registerChild: () => {}, isCancelled: cloneExists }),
      /Execution stopped by user/,
    );
    assert.equal(providerCalled, false);
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping mid-execution discards the executor result, cleans the clone, and frees the session", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-stop-discard", dir);
  const executorStarted = deferred();
  const releaseExecutor = deferred();
  const events = [];

  // The real clone runs; only the provider boundary is mocked, so we can stop while the executor
  // "runs" and prove its output is thrown away rather than stored for a decision.
  t.mock.method(provider("codex"), "run", async () => {
    executorStarted.resolve();
    await releaseExecutor.promise;
    return { text: "executor output", model: "test", durationMs: 1, exitCode: 0 };
  });
  // The reviewer must never run once a stop is accepted before review.
  t.mock.method(provider("claude"), "run", async () => { throw new Error("reviewer must not run after a stop"); });

  try {
    const runPromise = runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
    await executorStarted.promise;

    const stopPromise = stopExec(session.id);
    await nextEventLoopTurn();
    releaseExecutor.resolve();
    const stopResult = await stopPromise;
    await runPromise;

    assert.equal(stopResult.stopped, true);
    assert.equal(isExecuting(session.id), false);

    const saved = await getSession(session.id);
    // No awaiting_user record — the stopped run left nothing for the user to accept.
    assert.equal((saved.executions || []).some((e) => e.status === "awaiting_user"), false);
    // The isolated clone is gone.
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
    // The activity claim is released — claiming + releasing again must not throw 409 "busy".
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-stop-check")());
    // The reviewer was never reached, and the stop surfaced as an exec_error terminal event.
    assert.equal(events.some((e) => e.type === "exec_error"), true);
  } finally {
    releaseExecutor.resolve();
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop force-finalizes an execution whose provider never settles", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-stop-stall", dir);
  const executorStarted = deferred();
  const releaseExecutor = deferred();
  // settleExec's timeout timer is unref'd, so hold the loop open ourselves for the 50ms wait —
  // otherwise the test process could drain during the settle race (seen on the Node 22 CI runner).
  const keepLoopAlive = setInterval(() => {}, 25);
  const events = [];

  t.mock.method(provider("codex"), "run", async () => {
    executorStarted.resolve();
    await releaseExecutor.promise; // stalls until the finally releases it
    return { text: "unreachable", model: "test", durationMs: 1, exitCode: 0 };
  });
  t.mock.method(provider("claude"), "run", async () => { throw new Error("reviewer must not run after a stop"); });

  const runPromise = runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
  runPromise.catch(() => {});

  try {
    await executorStarted.promise;
    // The body is wedged in the mocked provider, so settle must give up and force-finalize.
    const stopResult = await stopExec(session.id, { settleTimeoutMs: 50 });

    assert.equal(stopResult.stopped, true);
    assert.equal(isExecuting(session.id), false);
    // The activity claim is released even though the body never unwound — the session is usable.
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-finalize-check")());
    assert.equal(events.some((e) => e.type === "exec_error"), true);

    // Force-finalize freed the session; releasing the wedged provider lets the body unwind, and its
    // own catch/finally still deletes the disposable clone — the stalled path doesn't leak it.
    releaseExecutor.resolve();
    await runPromise;
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
  } finally {
    clearInterval(keepLoopAlive);
    releaseExecutor.resolve();
    await runPromise.catch(() => {});
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that finalizes to awaiting_user emits exec_ready with no exec_error, and a later stop is a clean no-op", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-finalize-awaiting", dir);
  const events = [];

  // Both agents succeed: the executor writes a real change, the reviewer approves — so the run reaches
  // the finalizing save and persists an awaiting_user record.
  t.mock.method(provider("codex"), "run", async ({ cwd }) => {
    writeFileSync(join(cwd, "feature.txt"), "new feature\n");
    return { text: "executor output", model: "test", durationMs: 1, exitCode: 0 };
  });
  t.mock.method(provider("claude"), "run", async () => ({ text: "APPROVE — looks correct", model: "test", durationMs: 1, exitCode: 0 }));

  try {
    await runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));

    // The committed result stands: exec_ready fired, and — the guarantee this PR restores — no
    // exec_error was raced against it. The awaiting_user record is persisted for the user's decision.
    assert.equal(events.some((e) => e.type === "exec_ready"), true);
    assert.equal(events.some((e) => e.type === "exec_error"), false);
    const saved = await getSession(session.id);
    assert.equal((saved.executions || []).some((e) => e.status === "awaiting_user"), true);
    assert.equal(isExecuting(session.id), false);

    // The run already finished; a Stop now reports already_finished and must not surface a spurious
    // exec_error after the fact.
    assert.deepEqual(await stopExec(session.id), { stopped: false, status: "already_finished" });
    assert.equal(events.filter((e) => e.type === "exec_error").length, 0);
  } finally {
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop racing the finalize never emits both exec_error and exec_ready, and always frees the session", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-finalize-race", dir);
  const events = [];
  const reviewerDone = deferred();

  t.mock.method(provider("codex"), "run", async ({ cwd }) => {
    writeFileSync(join(cwd, "feature.txt"), "new feature\n");
    return { text: "executor output", model: "test", durationMs: 1, exitCode: 0 };
  });
  // Signal the moment review completes: the run then crosses into its finalizing save, so a stop
  // issued now genuinely races the finalize latch (rather than landing early, during the executor).
  t.mock.method(provider("claude"), "run", async () => {
    reviewerDone.resolve();
    return { text: "APPROVE", model: "test", durationMs: 1, exitCode: 0 };
  });

  try {
    const runPromise = runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
    await reviewerDone.promise;
    // The stop either lands just before enterExecFinalizing (honored → exec_error, no record) or is
    // refused by it (→ exec_ready, awaiting_user). The invariant this PR guarantees holds either way:
    // never BOTH, exactly one terminal outcome, and the session is always freed (never wedged busy).
    await stopExec(session.id);
    await runPromise;

    const errors = events.filter((e) => e.type === "exec_error").length;
    const readies = events.filter((e) => e.type === "exec_ready").length;
    assert.ok(!(errors > 0 && readies > 0), `must not emit both exec_error and exec_ready (got ${errors} error, ${readies} ready)`);
    assert.equal(errors + readies, 1, "exactly one terminal outcome");
    assert.equal(isExecuting(session.id), false);
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-race-check")());
  } finally {
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping a session that is not executing reports already_finished", async () => {
  const result = await stopExec("no-such-session");
  assert.deepEqual(result, { stopped: false, status: "already_finished" });
});
