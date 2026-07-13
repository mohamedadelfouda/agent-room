import test from "node:test";
import assert from "node:assert/strict";
import { validateOption } from "../../server/process.js";

test("validateOption accepts normal option values", () => {
  assert.equal(validateOption("sonnet", "model"), "sonnet");
  assert.equal(validateOption("gpt-5.6-sol", "model"), "gpt-5.6-sol");
  assert.equal(validateOption("claude", "command"), "claude");
  assert.equal(validateOption("high", "effort"), "high");
  assert.equal(validateOption("C:/Users/x/repo", "path"), "C:/Users/x/repo");
});

test("validateOption trims surrounding whitespace", () => {
  assert.equal(validateOption("  sonnet  ", "model"), "sonnet");
});

test("validateOption allows empty by default", () => {
  assert.equal(validateOption("", "model"), "");
  assert.equal(validateOption(null, "model"), "");
  assert.equal(validateOption(undefined, "model"), "");
});

test("validateOption rejects empty when allowEmpty is false", () => {
  assert.throws(() => validateOption("", "command", { allowEmpty: false }), /required/);
});

test("validateOption rejects shell metacharacters (command-injection guard)", () => {
  const dangerous = ["a; rm -rf /", "a && b", "a | b", "$(whoami)", "a`id`", "a > b", "a < b", "a'b", 'a"b', "a\nb", "a{b}"];
  for (const value of dangerous) {
    assert.throws(() => validateOption(value, "x"), /unsupported/, `should reject: ${JSON.stringify(value)}`);
  }
});

test("validateOption rejects values longer than 180 chars", () => {
  assert.throws(() => validateOption("a".repeat(181), "x"), /unsupported/);
  assert.equal(validateOption("a".repeat(180), "x"), "a".repeat(180));
});
