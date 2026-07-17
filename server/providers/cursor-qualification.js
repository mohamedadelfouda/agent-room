import { win32 as winPath } from "node:path";

// CU-0 (Cursor integration — Phase 0B) · SECURITY-QUALIFICATION MODEL · SPIKE ARTIFACT.
//
// Pure and fixtures-driven. These functions CONSUME evidence — a trusted-launch descriptor and the
// results of the qualification suite run against a real Cursor CLI — and DECIDE whether Cursor may act
// as a reviewer or an executor inside Agent Room. They are deliberately NOT imported by the provider
// registry or the process-trust layer: CU-0 only proves the model on fixtures. CU-1 wires this in for
// real, and only after the empirical suite passes on the owner's machine (see docs/CURSOR_CU0_SPIKE.md).
//
// The governing principle is FAIL-CLOSED: a layer is satisfied only when its evidence is exactly `true`.
// Missing, `false`, or malformed evidence is treated as "not guaranteed" → not qualified. No layer is
// ever inferred from another, and there is no silent fallback to a weaker mode.

export const CURSOR_QUALIFICATION_SCHEMA_VERSION = 1;

// CU-0 scope is explicitly Windows x64 experimental only. A descriptor validated on one platform/arch
// is not portable — the launcher, sandbox backend, and install paths differ per platform.
export const CURSOR_SUPPORTED_PLATFORM = "win32";
export const CURSOR_SUPPORTED_ARCH = "x64";

// Reviewer boundary = a layered AND. A reviewer must not be able to mutate anything outside a disposable
// test repo, reach the network, or be steered by untrusted project settings. `--mode plan` and the
// absence of `--force` are PRODUCT behaviors, not a security boundary on their own, so they are
// necessary but never sufficient — the containment layers around them are what make review safe.
export const REQUIRED_REVIEW_LAYERS = Object.freeze([
  "descriptorValid",                  // the trusted launch chain (node + index.js) validates by fingerprint
  "envIsolated",                      // launch env sanitized — NODE_OPTIONS / NODE_* cannot inject --require before Cursor
  "planMode",                         // invoked with --mode plan
  "noForce",                          // no --force / --yolo (changes are proposed, not applied)
  "configIsolated",                   // isolated CURSOR_CONFIG_DIR — not the user's real config
  "projectSettingsUntrustedDisabled", // a malicious .cursor/cli.json in the project cannot take effect
  "networkDenied",                    // the reviewer runs with network access denied
  "filesystemVerified",               // full name+hash snapshot: no project/parent/home change, incl. hidden & ignored
  "disposableRepo",                   // ran against a disposable clone, never the real repository
]);

// Executor boundary = every reviewer layer PLUS containment, process-control, and sandbox-trust layers.
// Writing is only allowed inside the clone; everything outside it, the network, and an untrusted or
// absent Cursor sandbox must all fail closed.
export const REQUIRED_EXECUTE_LAYERS = Object.freeze([
  "cloneWriteAllowed",     // writes inside the clone succeed (the executor capability itself)
  "parentWriteBlocked",    // a write to ../outside.txt is rejected
  "homeWriteBlocked",      // a write into Home is rejected
  "junctionEscapeBlocked", // a junction/symlink pointing outside the workspace is rejected
  "childProcessConfined",  // spawned child processes inherit the restrictions
  "stopKillsProcessTree",  // Stop terminates Cursor and every child it spawned
  "networkMatrixBlocked",  // DNS / HTTP / HTTPS / direct-IP / localhost / local-ports / child / no-sandbox all denied
  "sandboxFailClosed",     // a sandbox failure aborts the run — never a silent fallback to unsandboxed
  "cursorSandboxTrusted",  // cursorsandbox.exe is present and its fingerprint matches the trust chain
  "secretScanIntact",      // the secret scan on the produced diff still runs and passes
  "reviewedTreeBinding",   // the reviewed-tree binding is unchanged
  "noCursorWorktreeInClone", // Cursor did not spawn its own worktree inside the clone
]);

const NODE_FLAG = /^-/; // any argv token starting with "-" is a Node flag when it precedes the entry point

function isWithin(root, target) {
  // True when `target` resolves inside `root` (win32 semantics — this is a Windows-only descriptor).
  if (!winPath.isAbsolute(root) || !winPath.isAbsolute(target)) return false;
  const rel = winPath.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !winPath.isAbsolute(rel);
}

/**
 * Validate a Cursor trusted-launch descriptor.
 *
 * The descriptor binds a fixed launch chain (`trusted node.exe → trusted index.js → [request args]`) by
 * fingerprint, so Agent Room can run Cursor's Node entry point WITHOUT adding the generic `node.exe` to
 * the process allowlist (which would let any bug or input run `node <untrusted-script>`). The critical
 * invariant is that NO Node flag may precede `index.js`: `node --require evil.js index.js` would execute
 * attacker code before Cursor ever starts, so the fixed prefix must be exactly the entry point.
 *
 * Pure and synchronous. Fingerprint/realpath equality against the on-disk binaries is a RUNTIME check the
 * caller performs separately; this validates the descriptor's shape and argv-boundary invariants.
 *
 * @param {object} descriptor
 * @param {{trustedRoot: string, expectedProviderId?: string}} options
 *   trustedRoot — REQUIRED win32 absolute path of the trusted Cursor version directory; `executable` and
 *   `entryPoint` must resolve within it. A missing trustedRoot fails closed — containment cannot be skipped.
 * @returns {{valid: boolean, violations: string[]}}
 */
export function validateTrustedLaunchDescriptor(descriptor, { trustedRoot = null, expectedProviderId = "cursor" } = {}) {
  if (!descriptor || typeof descriptor !== "object") {
    return { valid: false, violations: ["descriptor is missing or not an object"] };
  }
  const violations = [];
  const absolute = (value) => typeof value === "string" && value.length > 0 && winPath.isAbsolute(value);

  if (descriptor.schemaVersion !== 1) violations.push("schemaVersion must be 1");
  if (descriptor.providerId !== expectedProviderId) {
    violations.push(`providerId must be "${expectedProviderId}" — descriptors are provider-bound and not shareable`);
  }
  if (!absolute(descriptor.executable)) violations.push("executable must be an absolute path");
  if (!absolute(descriptor.entryPoint)) violations.push("entryPoint must be an absolute path");
  if (typeof descriptor.executableFingerprint !== "string" || descriptor.executableFingerprint === "") {
    violations.push("executableFingerprint is required");
  }
  if (typeof descriptor.entryPointFingerprint !== "string" || descriptor.entryPointFingerprint === "") {
    violations.push("entryPointFingerprint is required");
  }

  const prefix = descriptor.fixedPrefixArgs;
  if (!Array.isArray(prefix) || prefix.length === 0) {
    violations.push("fixedPrefixArgs must be a non-empty array");
  } else if (!prefix.every((arg) => typeof arg === "string")) {
    violations.push("fixedPrefixArgs must contain only strings");
  } else {
    const entryIndex = prefix.indexOf(descriptor.entryPoint);
    if (entryIndex === -1) {
      violations.push("fixedPrefixArgs must include the entryPoint");
    } else if (entryIndex !== 0) {
      violations.push("entryPoint must be the first fixed-prefix arg (trusted node → trusted index.js → request args)");
    }
    // No Node flag may appear before the entry point — it would run code before Cursor starts.
    const beforeEntry = entryIndex === -1 ? prefix : prefix.slice(0, entryIndex);
    if (beforeEntry.some((arg) => NODE_FLAG.test(arg))) {
      violations.push("no Node flags may precede the entryPoint (e.g. --require/--import run code before Cursor)");
    }
  }

  if (descriptor.platform !== CURSOR_SUPPORTED_PLATFORM) {
    violations.push(`platform must be "${CURSOR_SUPPORTED_PLATFORM}" (CU-0 scope: Windows x64 experimental only)`);
  }
  if (descriptor.arch !== CURSOR_SUPPORTED_ARCH) {
    violations.push(`arch must be "${CURSOR_SUPPORTED_ARCH}" (CU-0 scope: Windows x64 experimental only)`);
  }

  // Containment is mandatory: a missing trustedRoot fails closed instead of skipping the check, otherwise a
  // descriptor pointing anywhere on disk would validate. trustedRoot is the trusted Cursor version
  // directory, always known at the (CU-1) call site that builds the descriptor.
  if (!trustedRoot) {
    violations.push("trustedRoot must be supplied to verify launch-chain containment");
  } else {
    if (absolute(descriptor.entryPoint) && !isWithin(trustedRoot, descriptor.entryPoint)) {
      violations.push("entryPoint must resolve within the trusted Cursor version directory");
    }
    if (absolute(descriptor.executable) && !isWithin(trustedRoot, descriptor.executable)) {
      violations.push("executable must resolve within the trusted Cursor version directory");
    }
  }

  return { valid: violations.length === 0, violations };
}

function unmetLayers(tests, layers) {
  // Fail-closed: a layer is met only when its evidence is exactly `true`.
  const source = tests && typeof tests === "object" ? tests : {};
  return layers.filter((layer) => source[layer] !== true);
}

/**
 * Derive Cursor's review/execute qualification from suite evidence.
 *
 * `reviewQualified` is true only when EVERY reviewer layer is proven; `executeQualified` requires the full
 * reviewer floor PLUS every executor layer. Any layer that is not exactly `true` — missing, false, or
 * malformed — leaves that capability unqualified and is listed in `reasons`. There is no partial credit
 * and no capability is inferred from another.
 *
 * @param {{version?: string, platform?: string, arch?: string, tests?: Record<string, boolean>}} [evidence]
 * @returns {{schemaVersion: number, provider: "cursor", version: string|null, platform: string|null,
 *   arch: string|null, reviewQualified: boolean, executeQualified: boolean,
 *   tests: {review: Record<string, boolean>, execute: Record<string, boolean>}, reasons: string[]}}
 */
export function deriveCursorQualification(evidence = {}) {
  const tests = evidence?.tests;
  const reviewUnmet = unmetLayers(tests, REQUIRED_REVIEW_LAYERS);
  const executeUnmet = unmetLayers(tests, REQUIRED_EXECUTE_LAYERS);
  const reviewQualified = reviewUnmet.length === 0;
  const executeQualified = reviewQualified && executeUnmet.length === 0;

  const reasons = [
    ...reviewUnmet.map((layer) => `review layer not guaranteed: ${layer}`),
    ...executeUnmet.map((layer) => `execute layer not guaranteed: ${layer}`),
  ];
  // Executor layers can all pass while the reviewer floor does not — execution still cannot qualify.
  if (!reviewQualified && executeUnmet.length === 0) {
    reasons.push("execute blocked: every reviewer layer must pass before execution can qualify");
  }

  return {
    schemaVersion: CURSOR_QUALIFICATION_SCHEMA_VERSION,
    provider: "cursor",
    version: typeof evidence?.version === "string" ? evidence.version : null,
    platform: typeof evidence?.platform === "string" ? evidence.platform : null,
    arch: typeof evidence?.arch === "string" ? evidence.arch : null,
    reviewQualified,
    executeQualified,
    tests: {
      review: Object.fromEntries(REQUIRED_REVIEW_LAYERS.map((layer) => [layer, tests?.[layer] === true])),
      execute: Object.fromEntries(REQUIRED_EXECUTE_LAYERS.map((layer) => [layer, tests?.[layer] === true])),
    },
    reasons,
  };
}
