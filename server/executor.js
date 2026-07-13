import { createWorktree, getDiff, commitAll } from "./worktree.js";
import { runClaude } from "./adapters/claude.js";
import { runCodex } from "./adapters/codex.js";

const adapters = { claude: runClaude, codex: runCodex };

// Run exactly ONE executor with write permissions inside its own isolated worktree.
// The reviewer is a separate, read-only step — this function never runs two writers.
export async function runExecution({ projectPath, executor, mode = "edit", task, config = {}, onEvent, registerChild }) {
  if (!adapters[executor]) throw new Error(`Unknown executor: ${executor}`);
  if (!task || !String(task).trim()) throw new Error("Execution task is empty");
  if (mode === "read") throw new Error("Executor mode must allow writing (edit / run / full)");

  const taskId = "t-" + crypto.randomUUID().slice(0, 8);
  const wt = await createWorktree(projectPath, executor, taskId);

  const result = await adapters[executor]({
    prompt: task,
    config: { ...config, permission: mode },
    cwd: wt.path,
    onEvent,
    registerChild,
  });

  const diff = await getDiff(wt.path);
  // Commit the executor's work onto its branch so accept (merge/PR) has something to take.
  await commitAll(wt.path, `agent(${executor}): ${String(task).slice(0, 60)}`);
  return {
    taskId,
    executor,
    mode,
    worktree: { path: wt.path, branch: wt.branch, rel: wt.rel },
    text: result.text,
    meta: { model: result.model ?? null, effort: result.effort ?? null, durationMs: result.durationMs ?? null, exitCode: result.exitCode ?? null },
    diff,
  };
}
