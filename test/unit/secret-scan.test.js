import test from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, hasBlockingSecrets } from "../../server/secret-scan.js";

test("flags sensitive filenames (.env, keys) and blocks", () => {
  const f = scanForSecrets([{ path: "config/.env", content: "X=1" }]);
  assert.ok(f.some((x) => x.rule === "sensitive-filename"));
  assert.ok(hasBlockingSecrets(f));
  assert.ok(scanForSecrets([{ path: "server.key", content: "" }]).some((x) => x.rule === "sensitive-filename"));
});

test("detects a private key block (critical)", () => {
  const f = scanForSecrets([{ path: "a.txt", content: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc" }]);
  assert.ok(f.some((x) => x.rule === "private-key" && x.severity === "critical"));
});

test("detects provider tokens", () => {
  assert.ok(scanForSecrets([{ path: "a", content: "k sk-abcdefghij1234567890xyz" }]).some((x) => x.rule === "openai-key"));
  assert.ok(scanForSecrets([{ path: "a", content: "ghp_abcdefghijklmnopqrstuvwxyz0123" }]).some((x) => x.rule === "github-token"));
  assert.ok(scanForSecrets([{ path: "a", content: "AKIAIOSFODNN7EXAMPLE" }]).some((x) => x.rule === "aws-access-key-id"));
  assert.ok(scanForSecrets([{ path: "a", content: "AIza" + "B".repeat(35) }]).some((x) => x.rule === "google-api-key"));
});

test("detects secret-looking assignments", () => {
  assert.ok(scanForSecrets([{ path: "a.js", content: 'const password = "hunter2xyz";' }]).some((x) => x.rule === "secret-assignment"));
});

test("detects unquoted secret assignments but not code refs", () => {
  assert.ok(scanForSecrets([{ path: "config.sh", content: "DB_PASSWORD=supersecretlongvalue" }]).some((x) => x.rule === "secret-assignment-unquoted"));
  // env-var / code references should not false-positive
  assert.deepEqual(scanForSecrets([{ path: "a.js", content: "const password = process.env.PW;" }]), []);
  assert.deepEqual(scanForSecrets([{ path: "a.js", content: "let secret = require('./s');" }]), []);
});

test("reports the line number but never the secret value", () => {
  const f = scanForSecrets([{ path: "a", content: "line1\nx = sk-abcdefghij1234567890xyz\nline3" }]);
  const hit = f.find((x) => x.rule === "openai-key");
  assert.equal(hit.line, 2);
  assert.equal(JSON.stringify(hit).includes("sk-abcdefghij"), false);
});

test("clean files produce no findings", () => {
  const f = scanForSecrets([{ path: "src/app.js", content: "export const x = 1;\nconsole.log(x);" }]);
  assert.deepEqual(f, []);
  assert.equal(hasBlockingSecrets(f), false);
});
