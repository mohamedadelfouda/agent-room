#!/usr/bin/env node
// `agent-room` (and `npx agent-room`): start the local Agent Room server. It serves the web UI on
// 127.0.0.1 and opens the browser — the CLI is a launcher for that local app, not a terminal UI.
//
// Two things differ from a `git clone` + `node server/index.js` run, both handled here so a global
// install "just works":
//   1. Node floor — fail fast with a clear message on an unsupported runtime instead of a cryptic
//      syntax error deep in the server (mirrors scripts/source-preflight.mjs).
//   2. Data directory — a globally-installed package lives in a read-only, reinstall-wiped location, so
//      default the runtime dir to the user's home. An explicit AGENT_ROOM_RUNTIME_DIR always wins.
import os from "node:os";
import path from "node:path";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 22) {
  console.error(`Agent Room needs Node.js 22 or newer — you have ${process.versions.node}. Install Node 22+ and re-run.`);
  process.exit(1);
}

if (!process.env.AGENT_ROOM_RUNTIME_DIR) {
  process.env.AGENT_ROOM_RUNTIME_DIR = path.join(os.homedir(), ".agent-room");
}

try {
  await import(new URL("../server/index.js", import.meta.url).href);
} catch (error) {
  console.error(`Agent Room failed to start: ${error?.message || error}`);
  process.exit(1);
}
