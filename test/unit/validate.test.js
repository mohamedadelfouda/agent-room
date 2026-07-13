import test from "node:test";
import assert from "node:assert/strict";
import { validateOption, allowedCommand } from "../../server/process.js";

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

test("allowedCommand accepts known CLIs, including paths and .exe/.cmd", () => {
  assert.equal(allowedCommand("claude"), "claude");
  assert.equal(allowedCommand("C:/tools/claude.exe"), "C:/tools/claude.exe");
  assert.equal(allowedCommand("/usr/bin/gh"), "/usr/bin/gh");
  assert.equal(allowedCommand("codex.cmd"), "codex.cmd");
});

test("allowedCommand rejects arbitrary / unlisted / empty commands", () => {
  for (const bad of ["rm", "powershell", "node", "python", "curl", ""]) {
    assert.throws(() => allowedCommand(bad), /not allowed|required/);
  }
});

test("allowedCommand honors a custom allowlist and still blocks metacharacters", () => {
  assert.equal(allowedCommand("codex", new Set(["codex"])), "codex");
  assert.throws(() => allowedCommand("claude", new Set(["codex"])), /not allowed/);
  assert.throws(() => allowedCommand("claude; rm -rf"), /unsupported/);
});

test("allowedCommand blocks the shell:true space-tokenization bypass on Windows", () => {
  // On Windows runProcess uses shell:true; cmd.exe runs the first space-delimited token, so a
  // value whose last slash-segment is an allowlisted name would still launch something else —
  // reject it. Obviously-fake placeholders only (realistic attack strings can trip AV that
  // scans the compiled test as data).
  const bypass = ["EVILBIN /claude", "C:/Windows/System32/EVILBIN.exe /claude", "OTHERBIN /codex"];
  if (process.platform === "win32") {
    for (const bad of bypass) assert.throws(() => allowedCommand(bad), /spaces/);
  } else {
    // On POSIX runProcess uses shell:false, so a space can't split off a new command — a full
    // path with a space is passed as one safe argument and must be accepted (validateOption
    // still blocks shell metacharacters on every platform, covered above).
    assert.equal(allowedCommand("/opt/my tools/bin/codex"), "/opt/my tools/bin/codex");
  }
});
