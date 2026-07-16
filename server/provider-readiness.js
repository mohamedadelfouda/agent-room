import { expectedApiError } from "./api-errors.js";
import { approvedProviderCommand, checkCommand } from "./process.js";
import { provider } from "./providers/registry.js";

const READINESS_TTL_MS = 30000;
const readinessCache = new Map();

export function configuredProviderCommand(definition) {
  return process.env[definition.commandEnv] || definition.command;
}

export function trustedProviderCliPaths(definition) {
  return [process.env[definition.commandEnv], approvedProviderCommand(definition.id)].filter(Boolean);
}

export async function providerReadiness(providerId, { refresh = false } = {}) {
  const definition = provider(providerId);
  if (!definition) return { installed: false, version: "", detail: "Unknown provider" };
  const cached = readinessCache.get(definition.id);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const status = await checkCommand(
    approvedProviderCommand(definition.id) || configuredProviderCommand(definition),
    {
      allowedCommands: new Set([definition.command]),
      trustedPaths: trustedProviderCliPaths(definition),
    },
  );
  const value = { installed: status.ok, version: status.version, detail: status.detail };
  readinessCache.set(definition.id, { value, expiresAt: Date.now() + READINESS_TTL_MS });
  return value;
}

export async function assertProvidersReady(providerIds) {
  const statuses = await Promise.all(providerIds.map(async (providerId) => [providerId, await providerReadiness(providerId)]));
  const unavailable = statuses.find(([, status]) => !status.installed);
  if (!unavailable) return;
  const [providerId, status] = unavailable;
  const label = provider(providerId)?.label || providerId;
  throw expectedApiError("provider_unavailable", `${label} is unavailable: ${status.detail || "setup is required"}`, 503);
}

export function invalidateProviderReadiness(providerId) {
  readinessCache.delete(String(providerId || ""));
}
