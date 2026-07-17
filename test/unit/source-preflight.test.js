import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/source-preflight.mjs");

test("source-preflight passes on a supported host and never starts the server", () => {
  // The test runner itself is Node >= 22 with Git available, so the happy path must exit 0 and report OK.
  // execFileSync throws on a non-zero exit, so reaching the assertion already proves exit 0.
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /Preflight OK — Node .+ on .+\/.+\./);
  assert.doesNotMatch(out, /listening|server ready|127\.0\.0\.1/i); // it must not spawn the server
});
