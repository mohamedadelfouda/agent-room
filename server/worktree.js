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
// Captures the base SHA it branches from so the diff/secret-scan can be taken against the
// branch point — NOT HEAD — otherwise an executor that runs `git commit` itself would move
// HEAD past its own change and hide it from a HEAD-based diff.
export async function createWorktree(projectPath, agent, taskId) {
  if (!SAFE.test(agent) || !SAFE.test(taskId)) throw new Error("Invalid agent/taskId");
  if (!(await isGitRepo(projectPath))) throw new Error("Project is not a git repository");
  const { stdout: sha } = await git(["rev-parse", "HEAD"], projectPath);
  const baseSha = sha.trim();
  const rel = path.join(".agent-workspaces", agent, taskId);
  const wtPath = path.join(projectPath, rel);
  const branch = `agent/${agent}/${taskId}`;
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await git(["worktree", "add", "-b", branch, wtPath, "HEAD"], projectPath);
  return { path: wtPath, branch, rel, baseSha };
}

// Full diff of what the executor changed since the branch point, plus a compact stat.
// Diffs against baseSha (the branch point) — not HEAD — so it captures changes the agent
// staged AND any it committed itself (which would otherwise move HEAD past them and hide
// them). `add -N` (intent-to-add) makes untracked files show up WITHOUT writing their
// blobs to the object database (nothing is stored until a real commit, after the secret
// scan passes and the user accepts).
export async function getDiff(wtPath, baseSha) {
  const base = baseSha || "HEAD";
  await git(["add", "-A", "-N"], wtPath);
  const { stdout: patch } = await git(["diff", base, "--no-color"], wtPath);
  const { stdout: stat } = await git(["diff", base, "--stat", "--no-color"], wtPath);
  const { stdout: names } = await git(["diff", base, "--name-status", "--no-color"], wtPath);
  return { patch, stat: stat.trim(), files: names.trim() };
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

// The changed + new files (since baseSha) with their current on-disk contents, for the
// secret scan. Enumerated with `-z` so non-ASCII names aren't C-quoted. Deleted files are
// skipped; symlinks are NOT followed (a symlink to /dev/zero or a huge file would hang/OOM)
// and only their name is checked; files over MAX_SCAN_BYTES are name-checked only.
export async function changedFiles(wtPath, baseSha) {
  const base = baseSha || "HEAD";
  const names = new Set();
  const { stdout: diffZ } = await git(["diff", base, "--name-only", "-z"], wtPath);
  for (const n of diffZ.split("\0")) if (n) names.add(n);
  const { stdout: untrackedZ } = await git(["ls-files", "--others", "--exclude-standard", "-z"], wtPath);
  for (const n of untrackedZ.split("\0")) if (n) names.add(n);

  const out = [];
  for (const rel of names) {
    const full = path.join(wtPath, rel);
    let st;
    try { st = await fs.lstat(full); } catch { continue; } // deleted / gone — nothing to scan
    if (st.isSymbolicLink() || !st.isFile()) { out.push({ path: rel, content: "" }); continue; }
    // Files over the cap are flagged (oversize) so the scan can surface that they were
    // NOT content-scanned, rather than silently checking only the filename.
    if (st.size > MAX_SCAN_BYTES) { out.push({ path: rel, content: "", oversize: true }); continue; }
    let content = "";
    try { content = await fs.readFile(full, "utf8"); } catch {}
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

// Purge now-unreachable loose objects (best-effort). Used after discarding a
// blocked-secret execution: if the executor committed a secret to its branch itself,
// deleting the branch leaves those commits/blobs unreachable — prune drops them. Only
// removes objects unreachable from refs/reflogs, so the user's own data is untouched.
export async function pruneObjects(projectPath) {
  try { await git(["prune", "--expire=now"], projectPath); } catch {}
}

// Discard an executor's worktree and its branch (used on reject / cleanup).
export async function removeWorktree(projectPath, wtPath, branch) {
  try { await git(["worktree", "remove", "--force", wtPath], projectPath); } catch {}
  if (branch && SAFE.test(String(branch).replace(/^agent\//, "").replace(/\//g, "-"))) {
    try { await git(["branch", "-D", branch], projectPath); } catch {}
  }
  try { await git(["worktree", "prune"], projectPath); } catch {}
}
