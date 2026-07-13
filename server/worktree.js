import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

const SAFE = /^[a-zA-Z0-9_.-]+$/;

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || err.message || "").trim(); reject(err); }
      else resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

export async function isGitRepo(projectPath) {
  try { const { stdout } = await git(["rev-parse", "--is-inside-work-tree"], projectPath); return stdout.trim() === "true"; }
  catch { return false; }
}

// Create an isolated worktree + branch for one executor. Never share a worktree between agents.
export async function createWorktree(projectPath, agent, taskId) {
  if (!SAFE.test(agent) || !SAFE.test(taskId)) throw new Error("Invalid agent/taskId");
  if (!(await isGitRepo(projectPath))) throw new Error("Project is not a git repository");
  const rel = path.join(".agent-workspaces", agent, taskId);
  const wtPath = path.join(projectPath, rel);
  const branch = `agent/${agent}/${taskId}`;
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await git(["worktree", "add", "-b", branch, wtPath, "HEAD"], projectPath);
  return { path: wtPath, branch, rel };
}

// Full diff of what the executor changed (tracked + untracked), plus a compact stat.
// Diffs against HEAD — not the index — so it captures changes the agent may have
// already `git add`-ed as well as unstaged ones; otherwise a staged change would be
// invisible here yet still get committed. `add -N` (intent-to-add) makes untracked
// files show up WITHOUT writing their blobs to the object database (nothing is stored
// until a real commit, after the secret scan passes and the user accepts).
export async function getDiff(wtPath) {
  await git(["add", "-A", "-N"], wtPath);
  const { stdout: patch } = await git(["diff", "HEAD", "--no-color"], wtPath);
  const { stdout: stat } = await git(["diff", "HEAD", "--stat", "--no-color"], wtPath);
  const { stdout: names } = await git(["diff", "HEAD", "--name-status", "--no-color"], wtPath);
  return { patch, stat: stat.trim(), files: names.trim() };
}

// The changed + new files with their current on-disk contents, for the secret scan.
// Deleted files are skipped (nothing to scan); binary/unreadable files come back with
// empty content so only their filename is checked.
export async function changedFiles(wtPath) {
  const { stdout } = await git(["status", "--porcelain", "--untracked-files=all"], wtPath);
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.slice(0, 2).includes("D")) continue;
    let rel = line.slice(3).trim();
    if (rel.includes(" -> ")) rel = rel.split(" -> ").pop();
    rel = rel.replace(/^"(.*)"$/, "$1");
    let content = "";
    try { content = await fs.readFile(path.join(wtPath, rel), "utf8"); } catch {}
    out.push({ path: rel, content });
  }
  return out;
}

export async function listWorktrees(projectPath) {
  try { const { stdout } = await git(["worktree", "list", "--porcelain"], projectPath); return stdout.trim(); }
  catch { return ""; }
}

// Commit whatever the executor changed onto its branch, so it can be merged / pushed / PR'd.
export async function commitAll(wtPath, message) {
  await git(["add", "-A"], wtPath);
  try { await git(["commit", "-m", message], wtPath); return true; }
  catch (e) { if (/nothing to commit/i.test(e.message)) return false; throw e; }
}

export async function currentBranch(projectPath) {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], projectPath);
  return stdout.trim();
}

export async function hasRemote(projectPath) {
  try { const { stdout } = await git(["remote"], projectPath); return stdout.trim().length > 0; }
  catch { return false; }
}

// Merge the executor's branch into the project's current branch (accept -> keep changes locally).
export async function mergeBranch(projectPath, branch) {
  await git(["merge", "--no-ff", "--no-edit", branch], projectPath);
}

// Push the executor's branch to origin (needed before opening a PR).
export async function pushBranch(projectPath, branch) {
  await git(["push", "-u", "origin", branch], projectPath);
}

// Discard an executor's worktree and its branch (used on reject / cleanup).
export async function removeWorktree(projectPath, wtPath, branch) {
  try { await git(["worktree", "remove", "--force", wtPath], projectPath); } catch {}
  if (branch && SAFE.test(String(branch).replace(/^agent\//, "").replace(/\//g, "-"))) {
    try { await git(["branch", "-D", branch], projectPath); } catch {}
  }
  try { await git(["worktree", "prune"], projectPath); } catch {}
}
