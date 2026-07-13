import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../server/process.js";

// Run node against a temp .js FILE (not `-e`) so the script's own characters never hit
// cmd.exe under shell:true on Windows — keeps the test cross-platform.
function withScript(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ar-proc-"));
  const file = join(dir, "s.js");
  writeFileSync(file, body);
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("runProcess caps accumulated stdout so a runaway CLI can't blow up memory", async () => {
  await withScript("for(let i=0;i<300000;i++)console.log('xxxxxxxxxxxxxxxx')\n", async (file) => {
    const r = await runProcess({ command: "node", args: [file] });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length <= 5 * 1024 * 1024, `stdout ${r.stdout.length} should be capped near 4MB`);
    assert.match(r.stdout, /\[truncated\]/);
  });
});

test("runProcess caps a single line larger than the buffer (not just many lines)", async () => {
  // One ~6MB line with no newline: readline delivers it whole at EOF, so the cap must slice
  // the line itself, not merely gate on the pre-append length.
  await withScript("process.stdout.write('x'.repeat(6*1024*1024))\n", async (file) => {
    const r = await runProcess({ command: "node", args: [file] });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length <= 5 * 1024 * 1024, `stdout ${r.stdout.length} should be capped near 4MB`);
    assert.match(r.stdout, /\[truncated\]/);
  });
});

test("runProcess returns small output intact and streams every line", async () => {
  await withScript("console.log('a');console.log('b')\n", async (file) => {
    const lines = [];
    const r = await runProcess({ command: "node", args: [file], onStdoutLine: (l) => lines.push(l) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /a\r?\nb/);
    assert.deepEqual(lines, ["a", "b"]);
  });
});
