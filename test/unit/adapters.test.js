import test from "node:test";
import assert from "node:assert/strict";
import { runClaude } from "../../server/adapters/claude.js";
import { runCodex } from "../../server/adapters/codex.js";

// The allowlist must be enforced on the REAL execution path (runClaude/runCodex spawn the
// agent), not only on the diagnostic endpoints. A client-supplied command that isn't the
// adapter's own CLI must be rejected before any process is spawned.

test("runClaude rejects a non-allowlisted command before spawning", async () => {
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { command: "calc" }, cwd: process.cwd() }),
    /not allowed/,
  );
});

test("runCodex rejects a non-allowlisted command (even the other agent's CLI)", async () => {
  await assert.rejects(
    () => runCodex({ prompt: "hi", config: { command: "claude" }, cwd: process.cwd() }),
    /not allowed/,
  );
});

test("runClaude rejects the win32 space-tokenization shape when on Windows", async () => {
  if (process.platform !== "win32") return; // POSIX shell:false makes the space safe
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { command: "calc /claude" }, cwd: process.cwd() }),
    /spaces|not allowed/,
  );
});
