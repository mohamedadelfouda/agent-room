import test from "node:test";
import assert from "node:assert/strict";
import { provider, providerCatalog, providerIds } from "../../server/providers/registry.js";

test("provider registry exposes runnable Claude and Codex definitions", () => {
  assert.deepEqual(providerIds().sort(), ["claude", "codex"]);
  for (const id of providerIds()) {
    const definition = provider(id);
    assert.equal(typeof definition.run, "function");
    assert.ok(definition.efforts.length > 0);
  }
});

test("public provider catalog omits server functions", () => {
  for (const definition of providerCatalog()) {
    assert.equal("run" in definition, false);
    assert.equal("discoverModels" in definition, false);
    assert.equal(typeof definition.dynamicModels, "boolean");
  }
});

test("Codex exposes one honest write boundary and Claude remains review-only", () => {
  assert.deepEqual(provider("codex").capabilities.executeModes, ["run"]);
  assert.deepEqual(provider("claude").capabilities.executeModes, []);
});
