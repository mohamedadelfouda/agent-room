import test from "node:test";
import assert from "node:assert/strict";
import { getSetupStatus, installationType, probeGitAvailable } from "../../server/setup-status.js";
import { providerIds } from "../../server/providers/registry.js";

// Injected probes keep this pure composition test off the disk and off the network.
const readyDimensions = {
  dimensions: {
    installation: { state: "installed", version: "1.0" },
    trust: { state: "trusted" },
    auth: { state: "unknown", observedAt: null },
    operational: { available: true, reasonCode: null },
  },
};

test("getSetupStatus composes provider dimensions, Git, and capabilities", async () => {
  const status = await getSetupStatus({
    probeReadiness: async () => readyDimensions,
    probeGit: async () => ({ available: true, version: "2.40" }),
  });

  assert.equal(status.providers.length, providerIds().length);
  for (const entry of status.providers) {
    assert.ok(entry.provider && entry.label);
    assert.equal(entry.installation.state, "installed");
    assert.equal(typeof entry.canExecute, "boolean");
    assert.equal("executeModes" in entry, false); // internal field must not leak to the response
  }

  // Two operational providers + Git → discussion open; only an execute-capable provider (Codex) can execute.
  assert.equal(status.capabilities.discussion.available, true);
  assert.ok(status.capabilities.executionEngine.executorCandidates.includes("codex"));
  assert.equal(status.capabilities.executionEngine.executorCandidates.includes("claude"), false);
  assert.equal(status.git.available, true);
  assert.equal(status.installationType, "source");
});

test("getSetupStatus locks every capability when nothing is operational", async () => {
  const status = await getSetupStatus({
    probeReadiness: async () => ({
      dimensions: {
        installation: { state: "missing", version: "" },
        trust: { state: "not_required" },
        auth: { state: "unknown", observedAt: null },
        operational: { available: false, reasonCode: "not_installed" },
      },
    }),
    probeGit: async () => ({ available: false, version: "" }),
  });
  assert.equal(status.capabilities.discussion.available, false);
  assert.equal(status.capabilities.executionEngine.available, false);
  assert.equal(status.capabilities.gitFeatures.available, false);
  assert.equal(status.git.available, false);
});

test("getSetupStatus degrades to safe defaults when a probe returns no dimensions", async () => {
  const status = await getSetupStatus({
    probeReadiness: async () => ({}), // probe returned nothing usable
    probeGit: async () => ({ available: false, version: "" }),
  });
  for (const entry of status.providers) {
    assert.equal(entry.installation.state, "missing");
    assert.equal(entry.trust.state, "not_required");
    assert.equal(entry.auth.state, "unknown");
    assert.deepEqual(entry.operational, { available: false, reasonCode: "not_installed" });
    assert.equal("executeModes" in entry, false);
  }
  assert.equal(status.capabilities.discussion.available, false);
});

test("installationType is source outside Electron", () => {
  assert.equal(installationType(), "source");
});

test("probeGitAvailable collapses concurrent probes, caches within its TTL, and re-probes on refresh", async () => {
  // Mirrors providerReadiness's cache so a polling/re-checking Setup Doctor doesn't spawn `git --version`
  // on every call. `run` is injected to count spawns without touching the real git binary.
  let spawns = 0;
  const run = async () => { spawns += 1; return { ok: true, version: "2.40" }; };
  const [a, b] = await Promise.all([probeGitAvailable({ run }), probeGitAvailable({ run })]);
  assert.deepEqual(a, { available: true, version: "2.40" });
  assert.deepEqual(b, a); // concurrent calls collapse onto one in-flight probe
  assert.equal(spawns, 1);
  await probeGitAvailable({ run }); // within TTL → served from cache
  assert.equal(spawns, 1);
  await probeGitAvailable({ refresh: true, run }); // a re-check forces a fresh probe
  assert.equal(spawns, 2);
});
