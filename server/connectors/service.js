import crypto from "node:crypto";
import { getSession, mutateSession } from "../store.js";
import { connector, executeConnectorAction } from "./registry.js";
import { recordDecision } from "../decisions.js";
import { logError, redact } from "../logger.js";

const CREDENTIAL_FIELD_PARTS = new Set(["auth", "authorization", "credential", "credentials", "key", "password", "secret", "token"]);

function credentialField(name) {
  const separated = String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const parts = separated.split(/[^a-z0-9]+/);
  return parts.some((part) => CREDENTIAL_FIELD_PARTS.has(part))
    || /^(?:access|api|client|private|refresh|service)(?:key|secret|token)$/.test(parts.join(""));
}

function safeStructuredResult(result, fieldName = "") {
  if (fieldName && credentialField(fieldName)) return "<redacted>";
  if (typeof result === "string") return redact(result);
  if (Array.isArray(result)) return result.map((entry) => safeStructuredResult(entry));
  if (result && typeof result === "object") {
    return Object.fromEntries(Object.entries(result).map(([key, entry]) => [key, safeStructuredResult(entry, key)]));
  }
  return result;
}

function safeStoredResult(result, maxChars = 100000) {
  return (JSON.stringify(safeStructuredResult(result)) ?? "null").slice(0, maxChars);
}

function enabledConnector(session, connectorId) {
  const definition = connector(connectorId);
  if (!definition) throw new Error("Unknown connector");
  if (session.connectors?.[connectorId]?.enabled !== true) throw new Error(`${definition.label} connector is not enabled for this session`);
  if (session.project?.path && session.project.trusted !== true) throw new Error("Connectors stay disabled while the attached project is untrusted");
  return definition;
}

export async function setConnectorEnabled(sessionId, connectorId, enabled) {
  const definition = connector(connectorId);
  if (!definition) throw new Error("Unknown connector");
  return mutateSession(sessionId, (session) => {
    session.connectors ||= {};
    session.connectors[connectorId] = { enabled: enabled === true, changedAt: new Date().toISOString() };
    recordDecision(session, { type: "connector", outcome: enabled === true ? "enabled" : "disabled", metadata: { connector: connectorId } });
    return structuredClone(session.connectors[connectorId]);
  });
}

export async function requestConnectorAction(sessionId, connectorId, actionId, input = {}) {
  const serializedInput = JSON.stringify(input);
  if (Buffer.byteLength(serializedInput, "utf8") > 65536) throw new Error("Connector input exceeds the 64 KiB approval limit");
  const session = await getSession(sessionId);
  const definition = enabledConnector(session, connectorId);
  if (!Object.hasOwn(definition.actions, actionId)) throw new Error("Unknown connector action");
  const action = definition.actions[actionId];
  if (!action.stateChanging) {
    const result = await executeConnectorAction(connectorId, actionId, input);
    return { status: "completed", result: safeStructuredResult(result) };
  }
  return mutateSession(sessionId, (latest) => {
    enabledConnector(latest, connectorId);
    latest.connectorActions ||= [];
    if (latest.connectorActions.filter((item) => ["pending", "executing_unknown"].includes(item.status)).length >= 50) {
      throw new Error("Resolve existing connector proposals before creating more");
    }
    const proposal = {
      id: crypto.randomUUID(), connector: connectorId, action: actionId, input: structuredClone(input),
      status: "pending", createdAt: new Date().toISOString(),
    };
    latest.connectorActions.push(proposal);
    return structuredClone(proposal);
  });
}

export async function decideConnectorAction(sessionId, actionId, approve) {
  if (approve !== true && approve !== false) throw new Error("Connector approval must be a boolean");
  const claim = await mutateSession(sessionId, (session) => {
    const proposal = (session.connectorActions || []).find((item) => item.id === actionId);
    if (!proposal) throw new Error("Connector action not found");
    if (proposal.status !== "pending") throw new Error(`Connector action is already ${proposal.status}`);
    enabledConnector(session, proposal.connector);
    proposal.decidedAt = new Date().toISOString();
    if (approve !== true) {
      proposal.status = "rejected";
      recordDecision(session, { type: "connector_action", outcome: "rejected", taskId: proposal.id, metadata: { connector: proposal.connector, action: proposal.action } });
      return { rejected: true, proposal: structuredClone(proposal) };
    }
    // Claim exactly once before releasing the session lock. A crash during the external
    // call leaves executing_unknown, which is intentionally never retried automatically.
    proposal.status = "executing_unknown";
    recordDecision(session, { type: "connector_action", outcome: "approved", taskId: proposal.id, metadata: { connector: proposal.connector, action: proposal.action } });
    return {
      rejected: false,
      execution: { connector: proposal.connector, action: proposal.action, input: structuredClone(proposal.input) },
    };
  });
  if (claim.rejected) return claim.proposal;

  async function finish(update) {
    return mutateSession(sessionId, (session) => {
      const proposal = (session.connectorActions || []).find((item) => item.id === actionId);
      if (!proposal) throw new Error("Connector action disappeared while it was executing");
      if (proposal.status !== "executing_unknown") throw new Error(`Connector action changed to ${proposal.status} while it was executing`);
      Object.assign(proposal, update);
      return structuredClone(proposal);
    });
  }

  let result;
  try {
    result = await executeConnectorAction(claim.execution.connector, claim.execution.action, claim.execution.input);
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    try {
      await finish({
        status: "failed_after_approval",
        failedAt: new Date().toISOString(),
        error: redact(primaryError.message).slice(0, 2000),
      });
    } catch (stateError) {
      primaryError.stateUpdateError = redact(stateError.message);
      logError("connector failure state could not be saved", stateError.message);
    }
    throw primaryError;
  }
  return finish({
    status: "completed",
    completedAt: new Date().toISOString(),
    result: safeStoredResult(result),
  });
}
