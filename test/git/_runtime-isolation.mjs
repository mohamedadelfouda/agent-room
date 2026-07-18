// Redirect the app runtime dir to a throwaway location BEFORE any server module (store.js) is imported
// and freezes RUNTIME_ROOT. The git tests create real disposable clones and session files via the real
// code paths; without this they land under the repo's own runtime root (RUNTIME_ROOT defaults to the
// repo when AGENT_ROOM_RUNTIME_DIR is unset) and — because the out-of-project clone is no longer inside
// the temp project dir the tests delete — leak into the checkout on every run. Import this FIRST (before
// node:test and before any ../../server import) in every git test file that exercises execution clones.
//
// node --test isolates each test file in its own process, so this runs once per file. An operator-set
// AGENT_ROOM_RUNTIME_DIR (e.g. in CI) is respected rather than overridden.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.AGENT_ROOM_RUNTIME_DIR) {
  const runtime = mkdtempSync(join(tmpdir(), "ar-git-test-runtime-"));
  process.env.AGENT_ROOM_RUNTIME_DIR = runtime;
  process.on("exit", () => { try { rmSync(runtime, { recursive: true, force: true }); } catch {} });
}
