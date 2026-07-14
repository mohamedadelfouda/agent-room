import { runClaude } from "../adapters/claude.js";
import { discoverCodexModels, runCodex } from "../adapters/codex.js";

const providers = new Map([
  ["claude", {
    id: "claude",
    label: "Claude",
    command: "claude",
    commandEnv: "AGENT_ROOM_CLAUDE_COMMAND",
    updateArgs: ["update"],
    defaultModel: "sonnet",
    models: ["default", "best", "fable", "sonnet", "opus", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    capabilities: { web: true, projectRead: true, projectTransport: "mcp", connectors: true, executeModes: [] },
    run: runClaude,
  }],
  ["codex", {
    id: "codex",
    label: "Codex",
    command: "codex",
    commandEnv: "AGENT_ROOM_CODEX_COMMAND",
    defaultModel: "",
    models: [],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    capabilities: { web: false, projectRead: true, projectTransport: "sandbox", connectors: false, executeModes: ["run"] },
    discoverModels: discoverCodexModels,
    run: runCodex,
  }],
]);

export function provider(id) {
  return providers.get(String(id || "").toLowerCase()) || null;
}

export function providerIds() {
  return [...providers.keys()];
}

export function providerCatalog() {
  return [...providers.values()].map(({ run, discoverModels, commandEnv, updateArgs, ...definition }) => ({
    ...definition,
    dynamicModels: Boolean(discoverModels),
    canUpdate: Array.isArray(updateArgs) && updateArgs.length > 0,
  }));
}

export async function discoverProviderModels(id, options) {
  const definition = provider(id);
  if (!definition?.discoverModels) throw new Error("This provider does not expose model discovery");
  return definition.discoverModels(options);
}
