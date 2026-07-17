// I/O orchestration for the Setup Doctor's status (SETUP_DOCTOR_UPDATE_PLAN §6 PR1). Probes every
// provider's readiness and Git locally — NO network — then derives machine capabilities via the pure
// readiness-model. Kept apart from that pure core so the same contract backs the API (`GET
// /api/setup/status`), a future `agent-room doctor` CLI, and diagnostics. Probes are injectable so the
// composition is unit-tested without touching the disk.
import { providerReadiness } from "./provider-readiness.js";
import { provider, providerIds } from "./providers/registry.js";
import { deriveSetupCapabilities } from "./readiness-model.js";
import { checkCommand } from "./process.js";

// Coarse for now: desktop vs source. The git/zip/npm split is only consumed by Update Notify (SD-4) and
// is refined there rather than guessed here — but carried now so the terminal/update paths stay possible.
export function installationType() {
  return process.versions.electron ? "desktop" : "source";
}

async function probeGitAvailable() {
  const result = await checkCommand("git", { allowedCommands: new Set(["git"]) });
  return { available: Boolean(result.ok), version: result.ok ? result.version : "" };
}

export async function getSetupStatus({ refresh = false, probeReadiness = providerReadiness, probeGit = probeGitAvailable } = {}) {
  // Provider probes and the Git probe are independent — run them together.
  const [entries, git] = await Promise.all([
    Promise.all(providerIds().map(async (id) => {
      const definition = provider(id);
      const executeModes = definition?.capabilities?.executeModes || [];
      const dimensions = (await probeReadiness(id, { refresh }))?.dimensions || {};
      return {
        provider: id,
        label: definition?.label || id,
        installation: dimensions.installation || { state: "missing", version: "" },
        trust: dimensions.trust || { state: "not_required" },
        auth: dimensions.auth || { state: "unknown", observedAt: null },
        operational: dimensions.operational || { available: false, reasonCode: "not_installed" },
        canExecute: executeModes.length > 0,
        // Public docs/install page the Doctor's "open install page" button links to (never a shell command
        // the app runs — installs stay the user's explicit action). Empty when the provider defines none.
        installUrl: definition?.install?.url || "",
        executeModes,
      };
    })),
    probeGit(),
  ]);
  const capabilities = deriveSetupCapabilities({
    providers: entries.map((entry) => ({ provider: entry.provider, operational: entry.operational, executeModes: entry.executeModes })),
    gitAvailable: git.available,
  });
  // Drop the internal executeModes array from the response; the UI reads the boolean canExecute.
  const providers = entries.map(({ executeModes, ...rest }) => rest);
  return { providers, git, capabilities, installationType: installationType() };
}
