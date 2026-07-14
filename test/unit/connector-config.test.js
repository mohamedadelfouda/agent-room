import test from "node:test";
import assert from "node:assert/strict";
import {
  configureConnectorSecretStore,
  connectorConfigurationCatalog,
  saveConnectorConfiguration,
} from "../../server/connector-config.js";

const KEYS = ["AGENT_ROOM_GMAIL_ACCESS_TOKEN", "AGENT_ROOM_SUPABASE_URL", "AGENT_ROOM_SUPABASE_KEY"];

test("concurrent secure connector updates are serialized without losing either connector", async () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  let saved = null;
  configureConnectorSecretStore({
    available: true,
    persist: async (value) => { await new Promise((resolve) => setTimeout(resolve, 5)); saved = structuredClone(value); },
  });
  try {
    await Promise.all([
      saveConnectorConfiguration("gmail", { accessToken: "gmail-token" }),
      saveConnectorConfiguration("supabase", { url: "https://example.supabase.co", key: "supabase-key" }),
    ]);
    assert.equal(saved.gmail.accessToken, "gmail-token");
    assert.equal(saved.supabase.key, "supabase-key");
    assert.equal(connectorConfigurationCatalog().find((item) => item.id === "supabase").configured, true);
  } finally {
    configureConnectorSecretStore(null);
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
