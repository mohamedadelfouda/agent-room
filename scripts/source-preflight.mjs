#!/usr/bin/env node
// Source-install preflight (SETUP_DOCTOR_UPDATE_PLAN §6 PR3 / SD-3). A local check run *before* the
// server starts — the start wrappers chain `node scripts/source-preflight.mjs && node server/index.js`.
// It installs nothing and never spawns the server; it just verifies the host can run Agent Room and
// prints one terse line per concern. Install links and per-provider setup live in the in-app Setup
// Doctor, not duplicated here.
//
//   Node >= 22   → hard requirement (exit 1). The wrappers already gate on this to even reach here;
//                  re-checking keeps the script correct when run standalone.
//   Git present  → soft warning (exit 0). Only execution on your code needs Git — discussion works
//                  without it — so a missing Git must not block startup.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Exported pure predicates so the gate logic is unit-tested directly, without spawning a subprocess or
// downgrading the test runner's own Node.
export function isNodeSupported(nodeVersion) {
  const major = Number(String(nodeVersion).split(".")[0]);
  return Number.isInteger(major) && major >= 22;
}

// A missing Git surfaces as an ENOENT `error`; a signal-killed probe as a null `status` — both mean
// "no usable Git", so only a clean exit 0 counts as present.
export function isGitPresent(spawnResult) {
  return !spawnResult.error && spawnResult.status === 0;
}

function main() {
  if (!isNodeSupported(process.versions.node)) {
    console.error(`Agent Room needs Node.js 22 or newer (found ${process.versions.node}). https://nodejs.org/`);
    process.exitCode = 1; // set the code, don't process.exit() — that can cut off the stderr write above
    return;
  }
  // `git --version` is a read-only probe; spawnSync (not the server's command sandbox) is fine pre-server.
  if (!isGitPresent(spawnSync("git", ["--version"], { stdio: "ignore" }))) {
    console.warn("Note: Git was not found. Discussion works without it; install Git to unlock execution on your code.");
  }
  console.log(`Preflight OK — Node ${process.versions.node} on ${process.platform}/${process.arch}.`);
}

// Run only when executed directly (node scripts/source-preflight.mjs), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
