import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeProjectTool, projectToolDefinitions, registerProjectScope } from "../../server/project-tools.js";

test("project tools expose only bounded reads inside the registered root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-project-tools-"));
  const sessionId = "session_test_123";
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "export const ready = true;\n");
  const release = await registerProjectScope(sessionId, root);
  try {
    assert.deepEqual(projectToolDefinitions(sessionId).map((tool) => tool.name), ["project__list_directory", "project__read_file"]);
    const listing = await executeProjectTool(sessionId, "project__list_directory", { path: "src" });
    assert.deepEqual(listing, [{ name: "app.js", type: "file" }]);
    const read = await executeProjectTool(sessionId, "project__read_file", { path: "src/app.js", limit: 7 });
    assert.equal(read.content, "export ");
    assert.equal(read.eof, false);
    await assert.rejects(() => executeProjectTool(sessionId, "project__read_file", { path: "../outside.txt" }), /stay inside/);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(projectToolDefinitions(sessionId).length, 0);
});
