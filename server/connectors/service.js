import crypto from "node:crypto";
import { getSession, mutateSession } from "../store.js";
import { connector, executeConnectorAction } from "./registry.js";
import { recordDecision } from "../decisions.js";
import { redact } from "../logger.js";

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
  if (serializedInput.length > 65536) throw new Error("Connector input exceeds the 64 KiB approval limit");
  const session = await getSession(sessionId);
  const definition = enabledConnector(session, connectorId);
  const action = definition.actions[actionId];
  if (!action) throw new Error("Unknown connector action");
  if (!action.stateChanging) {
    return { status: "completed", result: await executeConnectorAction(connectorId, actionId, input) };
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
  const claim = await mutateSession(sessionId, (session) => {
    const proposal = (session.connectorActions || []).find((item) => item.id === actionId);
    if (!proposal) throw new Error("Connector action not found");
    if (proposal.status !== "pending") throw new Error(`Connector action is already ${proposal.status}`);
    enabledConnector(session, proposal.connector);
    proposal.decidedAt = new Date().toISOString();
    if (!approve) {
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
    await finish({
      status: "failed_after_approval",
      failedAt: new Date().toISOString(),
      error: redact(error.message).slice(0, 2000),
    });
    throw error;
  }
  return finish({
    status: "completed",
    completedAt: new Date().toISOString(),
    result: redact(JSON.stringify(result)).slice(0, 100000),
  });
}
