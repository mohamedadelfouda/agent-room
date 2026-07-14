import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CappedText, agentTimeoutMs, readTextFileCapped } from "../../server/output-limits.js";

test("CappedText caps by bytes and records truncation", () => {
  const value = new CappedText(5);
  value.append("abcdef");
  assert.equal(value.truncated, true);
  assert.match(value.toString(), /^abcde/);
  assert.match(value.toString(), /truncated/);
});

test("agentTimeoutMs validates configurable timeouts", () => {
  assert.equal(agentTimeoutMs("5000"), 5000);
  assert.throws(() => agentTimeoutMs("0"), /between 1000/);
  assert.throws(() => agentTimeoutMs("forever"), /integer/);
});

test("readTextFileCapped never reads an unbounded final response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ar-output-"));
  const file = join(dir, "final.txt");
  try {
    await writeFile(file, "abcdefghij");
    const result = await readTextFileCapped(file, 5);
    assert.equal(result.truncated, true);
    assert.match(result.text, /^abcde/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
