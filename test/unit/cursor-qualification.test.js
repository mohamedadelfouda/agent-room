import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTrustedLaunchDescriptor,
  deriveCursorQualification,
  REQUIRED_REVIEW_LAYERS,
  REQUIRED_EXECUTE_LAYERS,
} from "../../server/providers/cursor-qualification.js";

// The descriptor is a Windows-only artifact, so fixtures use win32 paths and the validator uses win32
// path semantics — these assertions are therefore deterministic on the Ubuntu/Windows/macOS CI matrix.
const TRUSTED_ROOT = "C:\\Users\\me\\.cursor\\versions\\2026.07.09-a3815c0";
const NODE = `${TRUSTED_ROOT}\\node.exe`;
const ENTRY = `${TRUSTED_ROOT}\\index.js`;

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cursor",
    executable: NODE,
    executableFingerprint: "sha256:node",
    entryPoint: ENTRY,
    entryPointFingerprint: "sha256:index",
    fixedPrefixArgs: [ENTRY],
    version: "2026.07.09-a3815c0",
    platform: "win32",
    arch: "x64",
    ...overrides,
  };
}

test("a well-formed Cursor trusted-launch descriptor validates", () => {
  assert.deepEqual(
    validateTrustedLaunchDescriptor(descriptor(), { trustedRoot: TRUSTED_ROOT }),
    { valid: true, violations: [] },
  );
});

test("a Node flag before the entry point is rejected — code would run before Cursor starts", () => {
  const result = validateTrustedLaunchDescriptor(
    descriptor({ fixedPrefixArgs: ["--require", "C:\\evil.js", ENTRY] }),
    { trustedRoot: TRUSTED_ROOT },
  );
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /no Node flags may precede/.test(v)));
  assert.ok(result.violations.some((v) => /entryPoint must be the first/.test(v)));
});

test("each descriptor invariant fails closed on its own", () => {
  const cases = [
    [{ schemaVersion: 2 }, /schemaVersion must be 1/],
    [{ providerId: "claude" }, /provider-bound/],
    [{ executable: "relative\\node.exe" }, /executable must be an absolute path/],
    [{ entryPoint: "relative\\index.js", fixedPrefixArgs: ["relative\\index.js"] }, /entryPoint must be an absolute path/],
    [{ executableFingerprint: "" }, /executableFingerprint is required/],
    [{ entryPointFingerprint: "" }, /entryPointFingerprint is required/],
    [{ fixedPrefixArgs: [] }, /non-empty array/],
    [{ fixedPrefixArgs: [NODE, ENTRY] }, /entryPoint must be the first/],
    [{ platform: "linux" }, /platform must be "win32"/],
    [{ arch: "arm64" }, /arch must be "x64"/],
  ];
  for (const [override, pattern] of cases) {
    const result = validateTrustedLaunchDescriptor(descriptor(override), { trustedRoot: TRUSTED_ROOT });
    assert.equal(result.valid, false, `${JSON.stringify(override)} should be invalid`);
    assert.ok(result.violations.some((v) => pattern.test(v)), `${JSON.stringify(override)} → ${pattern}`);
  }
});

test("an entryPoint outside the trusted version directory is rejected", () => {
  const outside = "C:\\Users\\me\\.cursor\\versions\\other\\index.js";
  const result = validateTrustedLaunchDescriptor(
    descriptor({ entryPoint: outside, fixedPrefixArgs: [outside] }),
    { trustedRoot: TRUSTED_ROOT },
  );
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /within the trusted Cursor version directory/.test(v)));
});

test("a missing or non-object descriptor fails closed", () => {
  assert.equal(validateTrustedLaunchDescriptor(null).valid, false);
  assert.equal(validateTrustedLaunchDescriptor("nope").valid, false);
  assert.equal(validateTrustedLaunchDescriptor(undefined).valid, false);
});

test("a descriptor validated without a trustedRoot fails closed — containment cannot be skipped", () => {
  const result = validateTrustedLaunchDescriptor(descriptor()); // no options → no trustedRoot
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /trustedRoot must be supplied/.test(v)));
});

test("containment rejects sibling-prefix, .. escape, cross-drive, and UNC paths", () => {
  const outside = [
    `${TRUSTED_ROOT}EVIL\\index.js`,        // sibling whose name is a prefix of the root
    `${TRUSTED_ROOT}\\..\\other\\index.js`, // .. escape back out of the version dir
    "D:\\2026.07.09-a3815c0\\index.js",     // different drive
    "\\\\server\\share\\index.js",          // UNC
  ];
  for (const entryPoint of outside) {
    const result = validateTrustedLaunchDescriptor(
      descriptor({ entryPoint, fixedPrefixArgs: [entryPoint] }),
      { trustedRoot: TRUSTED_ROOT },
    );
    assert.equal(result.valid, false, `${entryPoint} must not be contained`);
    assert.ok(result.violations.some((v) => /within the trusted Cursor version directory/.test(v)), entryPoint);
  }
  // A path genuinely nested inside the version directory is contained (no containment violation).
  const nested = `${TRUSTED_ROOT}\\node_modules\\cursor\\index.js`;
  const contained = validateTrustedLaunchDescriptor(
    descriptor({ entryPoint: nested, fixedPrefixArgs: [nested] }),
    { trustedRoot: TRUSTED_ROOT },
  );
  assert.deepEqual(contained.violations.filter((v) => /within the trusted/.test(v)), []);
});

const allTrue = (layers) => Object.fromEntries(layers.map((layer) => [layer, true]));

test("Cursor qualifies as a reviewer only when every reviewer layer is proven", () => {
  const q = deriveCursorQualification({
    version: "2026.07.09-a3815c0", platform: "win32", arch: "x64",
    tests: allTrue(REQUIRED_REVIEW_LAYERS),
  });
  assert.equal(q.reviewQualified, true);
  assert.equal(q.executeQualified, false); // no executor layers supplied
  assert.equal(q.reasons.length, REQUIRED_EXECUTE_LAYERS.length);
  assert.equal(q.version, "2026.07.09-a3815c0");
});

test("Cursor qualifies as an executor only with the full reviewer floor plus every executor layer", () => {
  const q = deriveCursorQualification({ tests: allTrue([...REQUIRED_REVIEW_LAYERS, ...REQUIRED_EXECUTE_LAYERS]) });
  assert.equal(q.reviewQualified, true);
  assert.equal(q.executeQualified, true);
  assert.deepEqual(q.reasons, []);
});

test("a single unproven reviewer layer fails closed (network not proven denied)", () => {
  const tests = allTrue(REQUIRED_REVIEW_LAYERS);
  delete tests.networkDenied;
  const q = deriveCursorQualification({ tests });
  assert.equal(q.reviewQualified, false);
  assert.equal(q.executeQualified, false);
  assert.ok(q.reasons.some((r) => /networkDenied/.test(r)));
  assert.equal(q.tests.review.networkDenied, false);
});

test("execution fails closed when the sandbox is not proven fail-closed, even if all else passes", () => {
  const tests = allTrue([...REQUIRED_REVIEW_LAYERS, ...REQUIRED_EXECUTE_LAYERS]);
  tests.sandboxFailClosed = false;
  const q = deriveCursorQualification({ tests });
  assert.equal(q.reviewQualified, true);
  assert.equal(q.executeQualified, false);
  assert.ok(q.reasons.some((r) => /sandboxFailClosed/.test(r)));
});

test("execution cannot qualify while the reviewer floor fails, even if every executor layer passes", () => {
  const q = deriveCursorQualification({ tests: allTrue(REQUIRED_EXECUTE_LAYERS) });
  assert.equal(q.reviewQualified, false);
  assert.equal(q.executeQualified, false);
  assert.ok(q.reasons.some((r) => /reviewer layer must pass before execution/.test(r)));
});

test("empty or malformed evidence qualifies nothing, and a truthy-but-not-true layer is rejected", () => {
  for (const evidence of [undefined, {}, { tests: null }, { tests: { descriptorValid: "yes" } }]) {
    const q = deriveCursorQualification(evidence);
    assert.equal(q.reviewQualified, false);
    assert.equal(q.executeQualified, false);
  }
  // "yes" is truthy but not strictly true — fail-closed means it does not count as met.
  assert.equal(deriveCursorQualification({ tests: { descriptorValid: "yes" } }).tests.review.descriptorValid, false);
});
