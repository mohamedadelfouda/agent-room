import { execFile } from "node:child_process";
import { getSession, saveSession } from "./store.js";
import { runExecution } from "./executor.js";
import { removeWorktree, mergeBranch, pushBranch, hasRemote, pruneObjects } from "./worktree.js";
import { runClaude } from "./adapters/claude.js";
import { runCodex } from "./adapters/codex.js";
import { terminateProcess } from "./process.js";
import { hasBlockingSecrets } from "./secret-scan.js";
import { logError } from "./logger.js";

const activeExec = new Map();
const adapters = { claude: runClaude, codex: runCodex };

export function isExecuting(id) { return activeExec.has(id); }
export function stopExec(id) {
  const s = activeExec.get(id);
  if (!s) return false;
  s.cancelled = true;
  for (const c of s.children) terminateProcess(c);
  return true;
}

// Cancel every in-flight execution and kill its child processes — used at shutdown so an
// executor/reviewer agent never keeps running after the server exits. Each run's own
// finally block then clears its registry entry.
export async function abortAllExecutions(reason = "server_shutdown") {
  for (const [, s] of activeExec) {
    s.cancelled = true;
    // Shutdown path: SIGKILL now — the server's ~1500ms exit would beat the SIGTERM→SIGKILL
    // escalation timer, leaving a detached executor/reviewer running after the server exits.
    for (const c of s.children) terminateProcess(c, { immediate: true });
  }
}

function gh(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || err.message || "").trim(); reject(err); }
      else resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function reviewPrompt(task, execResult) {
  return `You are the REVIEWER. Read only — do not modify anything, just review.\n\n` +
    `The task that was implemented:\n${task}\n\n` +
    `The executor (${execResult.executor}) produced this diff:\n\n${execResult.diff.patch.slice(0, 120000)}\n\n` +
    `Review it: is it correct and complete? List any bugs, risks, or missing pieces. ` +
    `End with a clear verdict: APPROVE or REQUEST_CHANGES, with a one-line reason.`;
}

// One run: exactly one executor writes in an isolated worktree, then one reviewer reads the diff.
// Never two writers. Result waits for the user's accept/reject decision.
export async function runExecuteAndReview(sessionId, req, emit) {
  if (activeExec.has(sessionId)) throw new Error("An execution is already running for this session");
  const state = { cancelled: false, children: new Set() };
  activeExec.set(sessionId, state);
  const registerChild = (c) => { state.children.add(c); c.once("close", () => state.children.delete(c)); };

  try {
    const session = await getSession(sessionId);
    const project = session.project;
    if (!project?.path) throw new Error("اربط مجلد مشروع (git) أولاً");
    const executor = req.executor, reviewer = req.reviewer, mode = req.mode || "edit";
    if (!adapters[executor]) throw new Error("منفّذ غير معروف");
    if (executor === reviewer) throw new Error("المنفّذ والمراجع لازم يكونوا مختلفين");
    const task = String(req.task || "").trim();
    if (!task) throw new Error("مهمة التنفيذ فارغة");

    emit({ type: "exec_started", executor, reviewer, mode });

    // 1) Executor writes (single writer).
    emit({ type: "exec_phase", phase: "executing", agent: executor });
    const execResult = await runExecution({
      projectPath: project.path, executor, mode, task,
      config: req.agents?.[executor] || {},
      onEvent: (e) => emit({ type: "exec_activity", agent: executor, event: e }),
      registerChild,
    });

    // Secret gate: if the change carries secrets, stop before review/commit, discard
    // the worktree, and surface the findings (path/rule/line only — never the value).
    if (hasBlockingSecrets(execResult.secretFindings)) {
      emit({ type: "exec_phase", phase: "blocked_secret", agent: executor });
      await removeWorktree(project.path, execResult.worktree.path, execResult.worktree.branch);
      // If the executor committed the secret to its (now-deleted) branch itself, purge the
      // orphaned objects so the value isn't recoverable from the repo.
      await pruneObjects(project.path);
      const sBlocked = await getSession(sessionId);
      sBlocked.executions = sBlocked.executions || [];
      sBlocked.executions.push({
        taskId: execResult.taskId, executor, reviewer, mode, task,
        executorText: execResult.text, executorMeta: execResult.meta,
        diff: { files: execResult.diff.files, stat: execResult.diff.stat, patch: "" },
        secretFindings: execResult.secretFindings,
        review: null, status: "blocked_secret", createdAt: new Date().toISOString(),
      });
      await saveSession(sBlocked);
      emit({ type: "exec_secret_blocked", taskId: execResult.taskId, findings: execResult.secretFindings });
      emit({ type: "exec_ready", taskId: execResult.taskId });
      return;
    }

    // 2) Reviewer reads the diff (read-only, no writing).
    let review = null;
    if (reviewer && adapters[reviewer] && !state.cancelled) {
      emit({ type: "exec_phase", phase: "reviewing", agent: reviewer });
      const r = await adapters[reviewer]({
        prompt: reviewPrompt(task, execResult),
        config: { ...(req.agents?.[reviewer] || {}), permission: "read" },
        cwd: project.path,
        onEvent: (e) => emit({ type: "exec_activity", agent: reviewer, event: e }),
        registerChild,
      });
      review = { agent: reviewer, text: r.text, meta: { model: r.model ?? null, durationMs: r.durationMs ?? null } };
    }

    // 3) Store the execution record, awaiting the user's decision.
    const record = {
      taskId: execResult.taskId, executor, reviewer, mode, task,
      worktree: execResult.worktree,
      executorText: execResult.text, executorMeta: execResult.meta,
      diff: { files: execResult.diff.files, stat: execResult.diff.stat, patch: String(execResult.diff.patch).slice(0, 200000) },
      secretFindings: execResult.secretFindings, // non-blocking warnings (e.g. unscanned large files)
      review, status: "awaiting_user", createdAt: new Date().toISOString(),
    };
    const s2 = await getSession(sessionId);
    s2.executions = s2.executions || [];
    s2.executions.push(record);
    await saveSession(s2);
    emit({ type: "exec_ready", taskId: record.taskId });
  } catch (err) {
    logError("execution failed", err?.message || String(err));
    emit({ type: "exec_error", error: err.message });
    try {
      const s = await getSession(sessionId);
      s.messages.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), author: "system", content: `فشل التنفيذ: ${err.message}`, phase: "exec_error", mode: s.mode });
      await saveSession(s);
    } catch {}
  } finally {
    for (const c of state.children) terminateProcess(c);
    activeExec.delete(sessionId);
  }
}

function findExecution(session, taskId) {
  return (session.executions || []).find((e) => e.taskId === taskId);
}

// Accept: "merge" keeps the change on the local branch; "pr" pushes + opens a GitHub PR.
export async function acceptExecution(sessionId, taskId, action = "merge") {
  const session = await getSession(sessionId);
  const rec = findExecution(session, taskId);
  if (!rec) throw new Error("Execution not found");
  if (rec.status !== "awaiting_user") throw new Error(`Execution already ${rec.status}`);
  const projectPath = session.project.path;
  let result = {};

  if (action === "pr") {
    if (!(await hasRemote(projectPath))) throw new Error("المشروع مالوش origin على GitHub — استخدم merge محلي");
    await pushBranch(projectPath, rec.worktree.branch);
    const title = `Agent Room: ${rec.task.slice(0, 60)}`;
    const body = `Executed by **${rec.executor}** (mode: ${rec.mode}) in an isolated worktree.\n\n### Task\n${rec.task}\n\n### Reviewer (${rec.reviewer || "none"})\n${rec.review?.text || "—"}`;
    const { stdout } = await gh(["pr", "create", "--head", rec.worktree.branch, "--title", title, "--body", body], projectPath);
    result = { prUrl: stdout.trim() };
    rec.status = "pr_opened";
  } else {
    await mergeBranch(projectPath, rec.worktree.branch);
    await removeWorktree(projectPath, rec.worktree.path, rec.worktree.branch);
    rec.status = "merged";
  }
  rec.decidedAt = new Date().toISOString();
  rec.decision = action;
  Object.assign(rec, result);
  await saveSession(session);
  return { status: rec.status, ...result };
}

// Reject: discard the executor's worktree and branch entirely.
export async function rejectExecution(sessionId, taskId) {
  const session = await getSession(sessionId);
  const rec = findExecution(session, taskId);
  if (!rec) throw new Error("Execution not found");
  // A blocked_secret record has no worktree (already discarded) — guard against it.
  if (rec.worktree?.path) await removeWorktree(session.project.path, rec.worktree.path, rec.worktree.branch);
  rec.status = "rejected";
  rec.decidedAt = new Date().toISOString();
  await saveSession(session);
  return { status: "rejected" };
}
