import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSnapshot } from "../../server/project.js";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

test("projectSnapshot reports branch, tree, and read-only guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-snap-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "# hi\n");
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "index.js"), "// x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    const snap = await projectSnapshot(dir);
    assert.match(snap, /ATTACHED PROJECT/);
    assert.match(snap, /README\.md/);
    assert.match(snap, /server\//);
    assert.match(snap, /Read.?\/.?Grep.?\/.?Glob/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projectSnapshot is empty for no path", async () => {
  assert.equal(await projectSnapshot(""), "");
});
