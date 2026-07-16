import test from "node:test";
import assert from "node:assert/strict";
import { assertProvidersReady, providerReadiness } from "../../server/provider-readiness.js";

test("unknown or unavailable providers use the stable readiness error contract", async () => {
  assert.deepEqual(await providerReadiness("missing-provider"), {
    installed: false,
    version: "",
    detail: "Unknown provider",
  });
  await assert.rejects(
    () => assertProvidersReady(["missing-provider"]),
    (error) => error.apiStatus === 503 && error.apiCode === "provider_unavailable",
  );
});
