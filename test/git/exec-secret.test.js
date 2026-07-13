import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff, changedFiles } from "../../server/worktree.js";
import { scanForSecrets, hasBlockingSecrets } from "../../server/secret-scan.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

test("changed files are scanned; a secret is caught and getDiff writes no commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-secret-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    // Simulate an executor's changes: one clean file + one secret-bearing file.
    writeFileSync(join(dir, "app.js"), "export const x = 1;\n");
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-abcdefghij1234567890xyz\n");

    const diff = await getDiff(dir);
    assert.match(diff.files, /app\.js/);
    assert.match(diff.files, /\.env/);

    const files = await changedFiles(dir);
    assert.deepEqual(files.map((f) => f.path).sort(), [".env", "app.js"]);

    const findings = scanForSecrets(files);
    assert.ok(hasBlockingSecrets(findings), "should block on the .env secret");
    assert.ok(findings.some((f) => f.path === ".env"));

    // Intent-to-add must not have produced a commit — only the init commit exists.
    const commits = git(dir, "log", "--oneline").trim().split(/\r?\n/);
    assert.equal(commits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean change scans clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-clean-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    writeFileSync(join(dir, "app.js"), "export const add = (a, b) => a + b;\n");
    await getDiff(dir);
    const findings = scanForSecrets(await changedFiles(dir));
    assert.deepEqual(findings, []);
    assert.equal(hasBlockingSecrets(findings), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getDiff shows changes the agent already staged (diff vs HEAD, not index)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-staged-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    // The agent modifies + stages a file itself, plus leaves an untracked one.
    writeFileSync(join(dir, "README.md"), "hello\nworld\n");
    git(dir, "add", "README.md");
    writeFileSync(join(dir, "new.js"), "export const y = 2;\n");

    const diff = await getDiff(dir);
    assert.match(diff.files, /README\.md/, "staged change must appear in the review diff");
    assert.match(diff.files, /new\.js/, "untracked change must appear");
    assert.match(diff.patch, /world/, "staged content must be in the patch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
