// P1-6 integration proof: the real execute→review loop on a disposable repo with LIVE Codex + Claude.
//
// This is deliberately NOT in the default suite. `npm test`/`npm run ci` glob only test/unit and
// test/git, so this file runs only via `npm run test:integration`. It needs authenticated Codex +
// Claude CLIs (the executor spawns real provider processes), so it SKIPS cleanly when either is
// unavailable — safe to run in CI or on a fresh checkout, where it simply reports as skipped.
//
// It exists to guard the execute-write regression: Codex's isolated home once marked the project
// untrusted for every mode, so the executor ran read-only and the loop produced no diff. This asserts
// the executor actually writes (a real diff) and the reviewer actually reviews it.
//
// The persistent store is redirected to a disposable runtime dir BEFORE any server module loads, so a
// run never writes into the developer's real data/ store; everything is torn down in `finally`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("execute→review loop: Codex writes a fix in an isolated clone and Claude reviews it", async (t) => {
  // store.js freezes its data-dir constants at module load, so the runtime redirect must be set BEFORE
  // the first import. Dynamic-import every server module (no cache-buster) so store.js and the
  // orchestrator that imports it share ONE env-configured instance.
  const runtimeDir = await mkdtemp(join(tmpdir(), "exec-loop-runtime-"));
  const prevRuntime = process.env.AGENT_ROOM_RUNTIME_DIR;
  process.env.AGENT_ROOM_RUNTIME_DIR = runtimeDir;
  // On Windows, executor "run" fails closed unless this is set (no OS sandbox). This is a deliberate
  // live test on a throwaway repo, so opt in explicitly (and restore it in finally).
  const prevAllowWin = process.env.AGENT_ROOM_ALLOW_UNSANDBOXED_WINDOWS_EXEC;
  process.env.AGENT_ROOM_ALLOW_UNSANDBOXED_WINDOWS_EXEC = "1";
  const repo = await mkdtemp(join(tmpdir(), "exec-loop-it-"));
  try {
    const { createSession, getSession, mutateSession } = await import("../../server/store.js");
    const { runExecuteAndReview } = await import("../../server/exec-orchestrator.js");
    const { projectIdentity } = await import("../../server/project.js");
    const { configureTrustedCliStore, hydrateTrustedProviderCommands, approvedProviderCommand } = await import("../../server/process.js");
    const { providerReadiness } = await import("../../server/provider-readiness.js");

    // Provider commands come from the REAL trusted-CLI store (an explicit path, unaffected by the
    // runtime redirect above) — the test needs the actually-authenticated Codex/Claude to be found.
    configureTrustedCliStore(join(repoRoot, "data", "trusted-cli.json"));
    await hydrateTrustedProviderCommands().catch(() => {});
    const [codexReady, claudeReady] = await Promise.all([
      providerReadiness("codex", { refresh: true }),
      providerReadiness("claude", { refresh: true }),
    ]);
    if (!codexReady.installed || !claudeReady.installed) {
      t.skip("live Codex + Claude CLIs required (not authenticated on this machine)");
      return;
    }
    const codexCmd = approvedProviderCommand("codex");
    const claudeCmd = approvedProviderCommand("claude");

    const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
    git("init", "-q");
    await writeFile(join(repo, "add.js"), "export function add(a, b) {\n  return a - b; // BUG: subtraction, should be addition\n}\n");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

    const session = await createSession("exec-loop-integration");
    const identity = await projectIdentity(repo);
    await mutateSession(session.id, (s) => {
      s.project = {
        path: identity.realPath, fingerprint: identity.fingerprint,
        trusted: true, trustedAt: new Date().toISOString(), isGit: true, canOpenPr: false,
      };
    });

    await runExecuteAndReview(
      session.id,
      {
        executor: "codex", reviewer: "claude", mode: "run",
        task: "Fix the bug in add.js so that add(a, b) returns a + b.",
        agents: { codex: { command: codexCmd }, claude: { command: claudeCmd } },
      },
      () => {},
    );

    const reloaded = await getSession(session.id);
    const exec = reloaded.executions?.[reloaded.executions.length - 1];
    assert.ok(exec, "an execution was recorded");
    assert.ok(exec.diff?.patch, "executor produced a diff (the Windows regression left this empty)");
    assert.match(exec.diff.patch, /a \+ b/, "the diff applies the add-fix the task asked for");
    assert.ok(exec.review?.text, "reviewer produced a review of the diff");
  } finally {
    // Tear down the whole disposable runtime — do NOT rely on deleteSession, which refuses while the
    // execution sits in awaiting_user (its terminal-status guard), leaving the session file behind.
    if (prevRuntime === undefined) delete process.env.AGENT_ROOM_RUNTIME_DIR;
    else process.env.AGENT_ROOM_RUNTIME_DIR = prevRuntime;
    if (prevAllowWin === undefined) delete process.env.AGENT_ROOM_ALLOW_UNSANDBOXED_WINDOWS_EXEC;
    else process.env.AGENT_ROOM_ALLOW_UNSANDBOXED_WINDOWS_EXEC = prevAllowWin;
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
