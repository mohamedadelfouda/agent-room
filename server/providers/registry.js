import { runClaude } from "../adapters/claude.js";
import { discoverCodexModels, runCodex } from "../adapters/codex.js";

// Install guidance only — shown to the user for copy/paste, never executed by
// Agent Room. Claude needs its native installer because the npm package ships
// a JS shim without the native executable this host requires.
const installHint = (byPlatform) => byPlatform[process.platform] || byPlatform.default;

const providers = new Map([
  ["claude", {
    id: "claude",
    label: "Claude",
    command: "claude",
    commandEnv: "AGENT_ROOM_CLAUDE_COMMAND",
    install: {
      command: installHint({
        win32: "irm https://claude.ai/install.ps1 | iex",
        default: "curl -fsSL https://claude.ai/install.sh | bash",
      }),
      url: "https://code.claude.com/docs/en/install",
    },
    updateArgs: ["update"],
    updatePackage: "@anthropic-ai/claude-code",
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
    install: {
      command: installHint({
        win32: `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`,
        default: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      }),
      url: "https://github.com/openai/codex",
    },
    updateArgs: ["update"],
    updatePackage: "@openai/codex",
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
  return [...providers.values()].map(({ run, discoverModels, commandEnv, updateArgs, updatePackage, ...definition }) => ({
    ...definition,
    dynamicModels: Boolean(discoverModels),
    canUpdate: Array.isArray(updateArgs) && updateArgs.length > 0 && Boolean(updatePackage),
  }));
}

export async function discoverProviderModels(id, options) {
  const definition = provider(id);
  if (!definition?.discoverModels) throw new Error("This provider does not expose model discovery");
  return definition.discoverModels(options);
}
