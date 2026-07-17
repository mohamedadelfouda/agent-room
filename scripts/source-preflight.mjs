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

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  console.error(`Agent Room needs Node.js 22 or newer (found ${process.versions.node}). https://nodejs.org/`);
  process.exit(1);
}

// `git --version` is a read-only probe; spawnSync (not the server's command sandbox) is fine for a
// pre-server script. A missing Git surfaces as an ENOENT error rather than a non-zero status.
const git = spawnSync("git", ["--version"], { stdio: "ignore" });
if (git.error || git.status !== 0) {
  console.warn("Note: Git was not found. Discussion works without it; install Git to unlock execution on your code.");
}

console.log(`Preflight OK — Node ${process.versions.node} on ${process.platform}/${process.arch}.`);
process.exit(0);
