import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../../server/logger.js";

test("redact masks OpenAI-style sk- keys", () => {
  const out = redact("using sk-abcDEF1234567890xyz now");
  assert.match(out, /<redacted-key>/);
  assert.doesNotMatch(out, /abcDEF1234567890xyz/);
});

test("redact masks Bearer tokens", () => {
  const out = redact("sent header Bearer aa.bb.cc-DD_ee to api");
  assert.match(out, /Bearer <redacted>/);
  assert.doesNotMatch(out, /aa\.bb\.cc/);
});

test("redact masks TOKEN/SECRET/PASSWORD/API_KEY assignments", () => {
  assert.match(redact("GH_TOKEN=ghp_secretvalue"), /<redacted>/);
  assert.match(redact('API_KEY: "zzzzzzzz"'), /<redacted>/);
  assert.match(redact("password = hunter2"), /<redacted>/);
  assert.doesNotMatch(redact("GH_TOKEN=ghp_secretvalue"), /ghp_secretvalue/);
});

test("redact masks Windows user home paths", () => {
  const out = redact("wrote C:\\Users\\SomePerson\\project\\.env");
  assert.match(out, /<user>/);
  assert.doesNotMatch(out, /SomePerson/);
});

test("redact masks unix home paths", () => {
  assert.match(redact("path /home/someone/code"), /\/home\/<user>/);
  assert.match(redact("path /Users/someone/code"), /\/Users\/<user>/);
});

test("redact is a no-op for clean text", () => {
  assert.equal(redact("just a normal log line"), "just a normal log line");
});
