import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAcceptedChange } from "../../server/acceptance.js";
import { assertExecutionRepository, assertProjectReady, changedTreeFiles, commitAcceptedTree, createWorktree, mergeBranch, recoverAgentRoomIndexLock, removeWorktree, stageAcceptedTree } from "../../server/worktree.js";
import { hasBlockingSecrets, scanForSecrets } from "../../server/secret-scan.js";
import { acceptExecution, rejectExecution } from "../../server/exec-orchestrator.js";
import { createSession, getSession, rootPath, saveSession } from "../../server/store.js";
import { projectIdentity } from "../../server/project.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ar-accept-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "owner@example.com");
  git(dir, "config", "user.name", "Project Owner");
  writeFileSync(join(dir, ".gitignore"), ".agent-workspaces/\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("the public decision gate creates no commit before acceptance and uses the owner identity", async () => {
  const dir = repository();
  const session = await createSession("decision gate");
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-accept");
    writeFileSync(join(wt.path, "feature.js"), "export const ready = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);
    const identity = await projectIdentity(dir);
    session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true };
    session.executions = [{
      taskId: "t-accept",
      task: "add the ready feature",
      worktree: wt,
      reviewedTree,
      status: "awaiting_user",
      review: { text: "APPROVE" },
      diff: { files: "A feature.js", stat: "", patch: "" },
      projectPath: identity.realPath,
      projectFingerprint: identity.fingerprint,
    }];
    await saveSession(session);

    assert.equal(git(wt.path, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");
    assert.equal(git(dir, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");

    const result = await acceptExecution(session.id, "t-accept", "merge");
    assert.equal(result.status, "merged");
    assert.equal(git(dir, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "1");
    assert.equal(git(dir, "log", "-1", "--format=%an").trim(), "Project Owner");
    assert.equal((await getSession(session.id)).executions[0].decision, "merge");
    wt = null;
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.json`), { force: true });
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.summary.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accept re-scans and blocks a secret added after the preview", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "claude", "t-secret");
    writeFileSync(join(wt.path, "feature.js"), "export const ready = true;\n");
    writeFileSync(join(wt.path, ".env"), "OPENAI_API_KEY=sk-abcdefghij1234567890xyz\n");
    const result = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "must not commit" });
    assert.equal(result.blocked, true);
    assert.equal(git(wt.path, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project drift and dirty state both block acceptance", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-drift");
    writeFileSync(join(dir, "dirty.txt"), "dirty\n");
    await assert.rejects(() => assertProjectReady(dir, wt), /uncommitted changes/);
    git(dir, "clean", "-fdq");
    writeFileSync(join(dir, "README.md"), "changed\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-qm", "move head");
    await assert.rejects(() => assertProjectReady(dir, wt), /HEAD changed/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching to a different branch at the same SHA blocks acceptance", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "claude", "t-branch");
    git(dir, "switch", "-qc", "other");
    await assert.rejects(() => assertProjectReady(dir, wt), /branch changed/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worktree mutation after the immutable scan cannot enter the accepted commit", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-immutable");
    const feature = join(wt.path, "feature.js");
    writeFileSync(feature, "export const safe = true;\n");
    const treeSha = await stageAcceptedTree(wt.path, wt.baseSha);
    assert.equal(hasBlockingSecrets(scanForSecrets(await changedTreeFiles(wt.path, wt.baseSha, treeSha))), false);
    writeFileSync(feature, "export const key = 'sk-abcdefghij1234567890xyz';\n");

    await assert.rejects(() => commitAcceptedTree(wt.path, wt, treeSha, "immutable acceptance"), /changed after the accepted snapshot/);
    assert.equal(git(wt.path, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance commits the reviewed tree even if files change after review", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-reviewed-tree");
    const feature = join(wt.path, "feature.js");
    writeFileSync(feature, "export const reviewed = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);

    writeFileSync(feature, "export const late = true;\n");
    writeFileSync(join(wt.path, "late.js"), "export const unreviewed = true;\n");
    const accepted = await prepareAcceptedChange({
      projectPath: dir,
      worktree: wt,
      reviewedTree,
      message: "reviewed snapshot only",
    });

    assert.equal(git(dir, "show", `${accepted.acceptedRef}:feature.js`), "export const reviewed = true;\n");
    assert.throws(() => git(dir, "show", `${accepted.acceptedRef}:late.js`));
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packed secret objects remain confined to the disposable execution clone", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-packed-secret");
    writeFileSync(join(wt.path, "secret.txt"), "OPENAI_API_KEY=sk-abcdefghij1234567890xyz\n");
    git(wt.path, "add", "secret.txt");
    git(wt.path, "-c", "user.name=Executor", "-c", "user.email=executor@example.com", "commit", "-qm", "secret object");
    git(wt.path, "gc", "--prune=now");
    const blob = git(wt.path, "rev-parse", "HEAD:secret.txt").trim();
    git(wt.path, "cat-file", "-e", `${blob}^{blob}`);
    assert.throws(() => git(dir, "cat-file", "-e", `${blob}^{blob}`));

    const cleanup = await removeWorktree(dir, wt.path, wt.branch);
    assert.equal(cleanup.ok, true, cleanup.errors.join("; "));
    assert.equal(existsSync(wt.path), false);
    wt = null;
    assert.throws(() => git(dir, "cat-file", "-e", `${blob}^{blob}`));
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution metadata redirects are rejected before trusted Git operations", async (t) => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-metadata-link");
    try { symlinkSync(join(wt.path, "README.md"), join(wt.path, ".git", "metadata-link"), "file"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(() => assertExecutionRepository(wt), /metadata contains a redirect/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup refuses non-Agent-Room branches and preserves the user branch", async () => {
  const dir = repository();
  try {
    git(dir, "branch", "release/keep");
    const cleanup = await removeWorktree(dir, join(dir, ".agent-workspaces", "release", "keep"), "release/keep");
    assert.equal(cleanup.ok, false);
    assert.match(cleanup.errors.join("\n"), /cleanup safety check/);
    assert.equal(git(dir, "rev-parse", "--verify", "refs/heads/release/keep").trim().length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git identity and publication configuration drift block acceptance", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "claude", "t-config");
    git(dir, "config", "user.name", "Unexpected Author");
    await assert.rejects(() => assertProjectReady(dir, wt), /identity changed/);
    git(dir, "config", "user.name", "Project Owner");
    git(dir, "config", "core.hooksPath", "untrusted-hooks");
    await assert.rejects(() => assertProjectReady(dir, wt), /hooks, SSH, or signing/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent accept and reject produce one durable terminal decision", async () => {
  const dir = repository();
  const session = await createSession("decision race");
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-decision-race");
    writeFileSync(join(wt.path, "feature.js"), "export const accepted = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);
    const identity = await projectIdentity(dir);
    session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true };
    session.executions = [{
      taskId: "t-decision-race",
      task: "add accepted feature",
      worktree: wt,
      status: "awaiting_user",
      review: { text: "APPROVE" },
      diff: { files: "A feature.js", stat: "", patch: "" },
      projectPath: identity.realPath,
      projectFingerprint: identity.fingerprint,
      reviewedTree,
    }];
    await saveSession(session);

    const results = await Promise.allSettled([
      acceptExecution(session.id, "t-decision-race", "merge"),
      rejectExecution(session.id, "t-decision-race"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const saved = await getSession(session.id);
    const winner = saved.executions[0].decision;
    assert.ok(["merge", "reject"].includes(winner));
    if (winner === "merge") {
      assert.equal(saved.executions[0].status, "merged");
      assert.equal(git(dir, "show", "HEAD:feature.js"), "export const accepted = true;\n");
    } else {
      assert.equal(saved.executions[0].status, "rejected");
      assert.throws(() => git(dir, "show", "HEAD:feature.js"));
    }
    wt = null; // either terminal decision cleaned it up
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.json`), { force: true });
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.summary.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PR preflight rejects a non-GitHub origin without recording acceptance", async () => {
  const dir = repository();
  const session = await createSession("PR preflight");
  let wt;
  try {
    git(dir, "remote", "add", "origin", "https://gitlab.com/example/project.git");
    wt = await createWorktree(dir, "codex", "t-pr-preflight");
    writeFileSync(join(wt.path, "feature.js"), "export const ready = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);
    const identity = await projectIdentity(dir);
    session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true };
    session.executions = [{
      taskId: "t-pr-preflight",
      task: "publish accepted feature",
      worktree: wt,
      reviewedTree,
      status: "awaiting_user",
      review: { text: "APPROVE" },
      diff: { files: "A feature.js", stat: "", patch: "" },
      projectPath: identity.realPath,
      projectFingerprint: identity.fingerprint,
    }];
    await saveSession(session);

    await assert.rejects(() => acceptExecution(session.id, "t-pr-preflight", "pr"), /canonical GitHub/);
    const saved = await getSession(session.id);
    assert.equal(saved.executions[0].status, "awaiting_user");
    assert.equal(saved.executions[0].decision, undefined);
    assert.equal(saved.executions[0].acceptedAt, undefined);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.json`), { force: true });
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.summary.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const crashWindow of ["ref-only", "ref-and-index"]) {
  test(`accepted merge retry repairs the ${crashWindow} crash window`, async () => {
    const dir = repository();
    let wt;
    try {
      wt = await createWorktree(dir, "codex", `t-recover-${crashWindow}`);
      writeFileSync(join(wt.path, "recovered.js"), "export const recovered = true;\n");
      const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "recover accepted merge" });
      git(dir, "update-ref", wt.approval.baseRef, accepted.commitSha, wt.baseSha);
      if (crashWindow === "ref-and-index") git(dir, "read-tree", "--reset", "-u", accepted.commitSha);

      await assertProjectReady(dir, wt, { acceptedCommit: accepted.commitSha });
      await mergeBranch(dir, wt, accepted.commitSha);
      assert.equal(git(dir, "status", "--porcelain").trim(), "");
      assert.equal(git(dir, "show", "HEAD:recovered.js"), "export const recovered = true;\n");
    } finally {
      if (wt) await removeWorktree(dir, wt.path, wt.branch);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("merge precondition failures never rewrite a newer or different checkout", async () => {
  for (const scenario of ["target-moved", "branch-switched"]) {
    const dir = repository();
    let wt;
    try {
      wt = await createWorktree(dir, "codex", `t-precondition-${scenario}`);
      writeFileSync(join(wt.path, "accepted.js"), "export const accepted = true;\n");
      const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted candidate" });
      if (scenario === "target-moved") {
        writeFileSync(join(dir, "newer.js"), "export const newer = true;\n");
        git(dir, "add", "newer.js");
        git(dir, "commit", "-qm", "newer main");
      } else {
        git(dir, "switch", "-qc", "other");
        writeFileSync(join(dir, "other.txt"), "other branch\n");
        git(dir, "add", "other.txt");
        git(dir, "commit", "-qm", "other branch content");
      }
      const beforeHead = git(dir, "rev-parse", "HEAD").trim();
      const beforeTree = git(dir, "rev-parse", "HEAD^{tree}").trim();
      await assert.rejects(() => mergeBranch(dir, wt, accepted.commitSha), /moved before merge|checked-out branch changed/);
      assert.equal(git(dir, "rev-parse", "HEAD").trim(), beforeHead);
      assert.equal(git(dir, "write-tree").trim(), beforeTree);
      assert.equal(git(dir, "status", "--porcelain").trim(), "");
    } finally {
      if (wt) await removeWorktree(dir, wt.path, wt.branch);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("startup removes only Agent Room index locks, never an external Git lock", async () => {
  const dir = repository();
  const lockPath = join(dir, ".git", "index.lock");
  try {
    writeFileSync(lockPath, "external git lock");
    assert.equal(await recoverAgentRoomIndexLock(dir), false);
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { force: true });
    const indexPath = join(dir, ".git", "index");
    const indexBytes = readFileSync(indexPath);
    const staleTemporary = `${indexPath}.agent-room-stale`;
    writeFileSync(lockPath, indexBytes);
    writeFileSync(staleTemporary, indexBytes);
    writeFileSync(`${lockPath}.agent-room-intent`, JSON.stringify({
      phase: "installing", temporaryIndex: staleTemporary, indexCommit: git(dir, "rev-parse", "HEAD").trim(),
      targetRef: git(dir, "symbolic-ref", "HEAD").trim(), baseSha: git(dir, "rev-parse", "HEAD").trim(), commitSha: git(dir, "rev-parse", "HEAD").trim(),
      lockSha256: createHash("sha256").update(indexBytes).digest("hex"),
      lockIdentity: { dev: "different", ino: "different", birthtimeNs: "different" },
    }));
    assert.equal(await recoverAgentRoomIndexLock(dir), false);
    assert.equal(existsSync(lockPath), true, "same-content external lock must survive stale Agent Room intent");
    rmSync(lockPath, { force: true });
    rmSync(staleTemporary, { force: true });
    writeFileSync(lockPath, JSON.stringify({ agentRoom: true, nonce: "test-nonce" }));
    assert.equal(await recoverAgentRoomIndexLock(dir), true);
    assert.equal(existsSync(lockPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup finishes an accepted index after a crash following worktree refresh", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.agent-room-fault");
  const lockPath = join(dir, ".git", "index.lock");
  const intentPath = `${lockPath}.agent-room-intent`;
  try {
    wt = await createWorktree(dir, "codex", "t-refresh-crash");
    writeFileSync(join(wt.path, "after-crash.js"), "export const recovered = true;\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted before crash" });
    git(dir, "update-ref", wt.approval.baseRef, accepted.commitSha, wt.baseSha);
    execFileSync("git", ["read-tree", wt.baseSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    execFileSync("git", ["read-tree", "--reset", "-u", accepted.commitSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    writeFileSync(lockPath, JSON.stringify({ agentRoom: true, nonce: "fault-nonce" }));
    writeFileSync(intentPath, JSON.stringify({
      agentRoom: true, nonce: "fault-nonce", phase: "refreshing", temporaryIndex,
      indexCommit: accepted.commitSha, targetRef: wt.approval.baseRef, baseSha: wt.baseSha, commitSha: accepted.commitSha,
      previousIndexSha256: createHash("sha256").update(readFileSync(join(dir, ".git", "index"))).digest("hex"),
    }));

    assert.equal(await recoverAgentRoomIndexLock(dir), true);
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
    assert.equal(git(dir, "show", "HEAD:after-crash.js"), "export const recovered = true;\n");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup index recovery preserves project edits made while the app was down", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.agent-room-user-edit");
  const lockPath = join(dir, ".git", "index.lock");
  try {
    wt = await createWorktree(dir, "codex", "t-refresh-user-edit");
    writeFileSync(join(wt.path, "preserved.js"), "export const accepted = true;\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted before crash" });
    git(dir, "update-ref", wt.approval.baseRef, accepted.commitSha, wt.baseSha);
    execFileSync("git", ["read-tree", wt.baseSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    execFileSync("git", ["read-tree", "--reset", "-u", accepted.commitSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    writeFileSync(join(dir, "preserved.js"), "user edit after crash\n");
    writeFileSync(lockPath, JSON.stringify({ agentRoom: true, nonce: "edit-nonce" }));
    writeFileSync(`${lockPath}.agent-room-intent`, JSON.stringify({
      agentRoom: true, nonce: "edit-nonce", phase: "refreshing", temporaryIndex,
      indexCommit: accepted.commitSha, targetRef: wt.approval.baseRef, baseSha: wt.baseSha, commitSha: accepted.commitSha,
    }));

    assert.equal(await recoverAgentRoomIndexLock(dir), true);
    assert.equal(readFileSync(join(dir, "preserved.js"), "utf8"), "user edit after crash\n");
    assert.match(git(dir, "status", "--porcelain"), /preserved\.js/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});
