import { getSession, listSessions, mutateSession, scratchWorkspacePath, SKIP_SESSION_WRITE } from "./store.js";
import { terminateProcess } from "./process.js";
import { provider, providerIds } from "./providers/registry.js";
import { collaborationPrompt, debatePrompt, synthesisPrompt, chatPrompt } from "./prompts.js";
import { parseAgentControl, stripAgentControl, assessRound } from "./convergence.js";
import { assertTrustedProject, projectSnapshot } from "./project.js";
import fs from "node:fs/promises";
import { CappedText } from "./output-limits.js";
import { logError, redact } from "./logger.js";
import { registerProjectScope } from "./project-tools.js";
import { claimSessionActivity } from "./session-activity.js";
import { expectedApiError } from "./api-errors.js";
import {
  assertRunAcceptsOutput as assertAttemptAcceptsOutput,
  claimRunTerminal,
  createRunAttempt,
  requestRunCancellation,
  requestRunFailure,
  runAcceptsOutput as attemptAcceptsOutput,
  runAttemptRecord,
  runInactiveError,
  runWasCancelled,
} from "./run-state.js";

const activeRuns = new Map();
const DISCUSSION_MODES = new Set(["chat", "collaboration", "debate"]);
const MAX_ROLE_CODEPOINTS = 180;

function invalidRequest(code, message) {
  throw expectedApiError(code, message, 400);
}

function orchestrationMode(rawMode) {
  const mode = String(rawMode || "collaboration").trim().toLowerCase();
  if (!DISCUSSION_MODES.has(mode)) invalidRequest("invalid_mode", "Unsupported discussion mode");
  return mode;
}

function orchestrationRounds(rawRounds) {
  const rounds = rawRounds === undefined || rawRounds === "" ? 2 : Number(rawRounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    invalidRequest("invalid_rounds", "Rounds must be an integer from 1 to 5");
  }
  return rounds;
}

function orchestrationTask(content) {
  const userTask = String(content || "").trim();
  if (!userTask) invalidRequest("message_required", "Write a message first");
  return userTask;
}

function orchestrationAgents(agents) {
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    invalidRequest("invalid_participants", "Agent configuration must be an object");
  }
  for (const [providerId, config] of Object.entries(agents)) {
    if (config?.enabled === false) continue;
    if (!provider(providerId)) invalidRequest("invalid_provider", `Unknown provider: ${providerId}`);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      invalidRequest("invalid_participants", `Invalid configuration for provider: ${providerId}`);
    }
  }
  return agents;
}

function orchestrationParticipants(agents, mode) {
  const selected = providerIds().filter((providerId) => Boolean(agents[providerId]) && agents[providerId].enabled !== false);
  if (selected.length < 2) invalidRequest("invalid_participants", "Enable at least two providers for this mode");
  if (mode === "debate" && selected.length !== 2) {
    invalidRequest("invalid_debate_participants", "Debate mode requires exactly two providers");
  }
  for (const providerId of selected) {
    const role = String(agents[providerId].role || "");
    if ([...role].length > MAX_ROLE_CODEPOINTS) {
      invalidRequest("invalid_agent_role", `Role is too long for provider: ${providerId}`);
    }
  }
  return selected;
}

function orchestrationFinalizer(rawFinalizer, selected) {
  const finalizer = String(rawFinalizer || "none").trim().toLowerCase();
  if (finalizer !== "none" && !selected.includes(finalizer)) {
    invalidRequest("invalid_finalizer", "Finalizer must be none or one of the selected providers");
  }
  return finalizer;
}

export function validateOrchestrationRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    invalidRequest("invalid_orchestration_request", "Request body must be an object");
  }
  const mode = orchestrationMode(request.mode);
  const rounds = orchestrationRounds(request.rounds);
  const userTask = orchestrationTask(request.content);
  const agents = orchestrationAgents(request.agents);
  const selected = orchestrationParticipants(agents, mode);
  const finalizer = orchestrationFinalizer(request.finalizer, selected);
  return { mode, rounds, userTask, selected, finalizer };
}

function runAcceptsOutput(sessionId, state) {
  return attemptAcceptsOutput(activeRuns.get(sessionId), state);
}

function assertRunAcceptsOutput(sessionId, state) {
  assertAttemptAcceptsOutput(activeRuns.get(sessionId), state);
}

function makeMessage({ author, agent, role, content, round, phase, mode }) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    author,
    agent,
    role,
    content,
    round,
    phase,
    mode,
  };
}

function discussionOutcomePhase(assessment) {
  if (!assessment.canStop) return "needs_more_rounds";
  return {
    satisfied: "converged",
    needs_user: "needs_user",
    blocked: "blocked_external",
  }[assessment.completionState] || "needs_more_rounds";
}

export function buildDiscussionOutcome(assessment, requestedRounds, completedRounds) {
  const phase = discussionOutcomePhase(assessment);
  return {
    outcomeVersion: 1,
    phase,
    agreementState: assessment.agreementState,
    completionState: assessment.completionState,
    stopReason: assessment.canStop
      ? assessment.stopReason
      : assessment.stopReason === "invalid_control" ? "invalid_control" : "round_limit",
    requestedRounds,
    completedRounds,
    stoppedEarly: assessment.canStop && completedRounds < requestedRounds,
    itemRegistry: structuredClone(assessment.itemRegistry),
    pendingItems: structuredClone(assessment.pendingItems),
    pendingKinds: [...assessment.pendingKinds],
    nextSteps: structuredClone(assessment.nextSteps),
    disagreements: [...assessment.disagreements],
    unclassifiedPoints: [...assessment.unclassifiedPoints],
    conflicts: structuredClone(assessment.conflicts),
    controlValid: assessment.allValid,
  };
}

function pendingItemList(outcome) {
  return outcome.pendingItems.length
    ? `\n${outcome.pendingItems.map((pendingItem) => `• ${pendingItem.text}`).join("\n")}`
    : "";
}

function terminalOutcomeReport(outcome) {
  const round = outcome.completedRounds;
  if (outcome.phase === "converged") {
    return outcome.stoppedEarly
      ? `الوكلاء اتفقوا والمهمة اكتملت في الجولة ${round} — تم إيقاف الجولات المتبقية.`
      : `الوكلاء اتفقوا والمهمة اكتملت في الجولة الأخيرة (${round}).`;
  }
  if (outcome.phase === "needs_user") {
    return `الوكلاء متفقون، والنقاش توقف في الجولة ${round} لأن النتيجة تحتاج قرارك.${pendingItemList(outcome)}`;
  }
  if (outcome.phase === "blocked_external") {
    return `الوكلاء متفقون، والنقاش توقف في الجولة ${round} لأن النتيجة تنتظر تحققًا أو خطوة خارجية.${pendingItemList(outcome)}`;
  }
  return null;
}

function unfinishedOutcomeReport(outcome) {
  if (outcome.stopReason === "invalid_control") {
    return `انتهت ${outcome.completedRounds} جولات، لكن تعذّر اعتماد حالة الاتفاق لأن بيانات التحكم كانت ناقصة أو غير صالحة.`;
  }
  if (outcome.disagreements.length) {
    return `انتهت ${outcome.completedRounds} جولات وما زال هناك اختلاف جوهري بين الوكلاء:\n${outcome.disagreements.map((disagreement) => `• ${disagreement}`).join("\n")}`;
  }
  if (outcome.agreementState === "converged" && outcome.completionState === "incomplete") {
    return `انتهت ${outcome.completedRounds} جولات. الوكلاء متفقون على الوضع الحالي، لكن المهمة ما زالت تحتاج شغلًا إضافيًا.${pendingItemList(outcome)}`;
  }
  return `انتهت ${outcome.completedRounds} جولات من غير اتفاق نهائي قابل للاعتماد.`;
}

export function discussionOutcomeReport(outcome) {
  return terminalOutcomeReport(outcome) || unfinishedOutcomeReport(outcome);
}

export function mergeOrchestrationContent(latest, session) {
  // Connector MCP calls and user approvals can update the same session while an
  // agent is running. Merge messages by id instead of replacing those concurrent
  // connector/decision updates with this orchestration's older snapshot.
  const messages = new Map();
  for (const message of [...(latest.messages || []), ...(session.messages || [])]) messages.set(message.id, message);
  latest.messages = [...messages.values()].sort((a, b) => {
    const time = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    return time || String(a.id || "").localeCompare(String(b.id || ""));
  });
  latest.mode = session.mode;
  latest.settings = structuredClone(session.settings || {});
  return latest;
}

async function persistRunProgress(session, state, emit) {
  const persisted = await mutateSession(session.id, (latest) => {
    if (!runAcceptsOutput(session.id, state)) return SKIP_SESSION_WRITE;
    mergeOrchestrationContent(latest, session);
    latest.status = session.status;
    latest.activeRun = runAttemptRecord(state);
    return true;
  });
  if (persisted) emit({ type: "session_updated", sessionId: session.id, runId: state.runId });
  return persisted;
}

async function persistRunTerminal(session, state, emit) {
  const persisted = await mutateSession(session.id, (latest) => {
    if (activeRuns.get(session.id) !== state || state.status !== session.status) return SKIP_SESSION_WRITE;
    mergeOrchestrationContent(latest, session);
    latest.status = session.status;
    latest.activeRun = runAttemptRecord(state);
    return true;
  });
  if (persisted) emit({ type: "session_updated", sessionId: session.id, runId: state.runId });
  return persisted;
}

async function terminateRunChildren(state, options) {
  return Promise.all([...state.children].map((child) => terminateProcess(child, options)));
}

async function settlePendingProviders(state, timeoutMs = 5000) {
  if (state.pending.size === 0) return true;
  let timeoutHandle;
  const settled = Promise.allSettled([...state.pending]).then(() => true);
  const timedOut = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), timeoutMs);
    timeoutHandle.unref?.();
  });
  const completed = await Promise.race([settled, timedOut]);
  clearTimeout(timeoutHandle);
  return completed;
}

async function runParallel(factories, state) {
  let primaryError = null;
  const tasks = factories.map(async (factory) => {
    try {
      return await factory();
    } catch (error) {
      if (!error.runInactive && requestRunFailure(state)) {
        primaryError = error;
        await terminateRunChildren(state);
      }
      throw error;
    }
  });
  const outcomes = await Promise.allSettled(tasks);
  if (runWasCancelled(state)) throw runInactiveError(state);
  if (primaryError) throw primaryError;
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  if (rejected) throw rejected.reason;
  return outcomes.map((outcome) => outcome.value);
}

export async function stopRun(sessionId, { settleTimeoutMs = 5000 } = {}) {
  const state = activeRuns.get(sessionId);
  if (!state || !requestRunCancellation(state)) return false;
  const results = await terminateRunChildren(state);
  if (!(await settlePendingProviders(state, settleTimeoutMs))) {
    // Providers did not settle after cancellation (e.g. a stall in the un-timed setup phase,
    // before any child process exists to kill). Finalize the session now so it can't hang in
    // "running"; if a straggler promise settles later, the run body's terminal claim no-ops.
    await finalizeStalledStop(sessionId, state);
  }
  return results.every(Boolean);
}

async function finalizeStalledStop(sessionId, state) {
  if (!claimRunTerminal(state, "stopped", "stop_timeout")) return;
  const emit = state.emit || (() => {});
  try {
    const session = await getSession(sessionId);
    session.status = "stopped";
    session.messages.push(makeMessage({ author: "system", content: "Run stopped by user.", phase: "stopped", mode: session.mode }));
    await persistRunTerminal(session, state, emit);
    emit({ type: "run_stopped", sessionId, runId: state.runId });
  } catch (error) {
    // Match the success-path handling: on a persist failure surface run_error (not a false
    // run_stopped); startup reconciliation repairs the on-disk status on the next run.
    logError("failed to finalize stalled stopped run", redact(error?.message || String(error)));
    emit({ type: "run_error", sessionId, runId: state.runId, error: redact(error?.message || String(error)) });
  } finally {
    // The suspended run body's own finally will not run while its provider promise is stuck, so
    // release its held claims here. Both closures are idempotent, so if the straggler ever settles
    // and the run body's finally runs too, the second release is a safe no-op.
    state.releaseProjectScope?.();
    state.releaseActivity?.();
    if (activeRuns.get(sessionId) === state) activeRuns.delete(sessionId);
  }
}

export function isRunning(sessionId) {
  return activeRuns.has(sessionId);
}

// Stop every in-flight run and mark its session interrupted — used during graceful shutdown
// so we never leave a session stuck in "running" after the process exits.
export async function abortAllRuns(reason = "server_shutdown") {
  for (const [sessionId, state] of activeRuns) {
    requestRunCancellation(state);
    // Shutdown path: SIGKILL now (see terminateProcess) so a detached agent can't outlive the
    // server's ~1500ms exit, which would otherwise beat the SIGTERM→SIGKILL escalation timer.
    await terminateRunChildren(state, { immediate: true });
    if (!claimRunTerminal(state, "interrupted", reason)) continue;
    try {
      await mutateSession(sessionId, (session) => {
        if (activeRuns.get(sessionId) !== state) return;
        session.status = "interrupted";
        session.activeRun = runAttemptRecord(state);
        session.messages.push(makeMessage({
          author: "system",
          content: `تم إيقاف التشغيل بشكل مفاجئ: ${reason}`,
          phase: "interrupted",
          mode: session.mode,
        }));
      });
    } catch (error) {
      logError("failed to mark interrupted discussion", redact(error?.message || String(error)));
    }
  }
}

export async function reconcileInterruptedRuns(reason = "server_restart") {
  const summaries = await listSessions();
  let recovered = 0;
  for (const summary of summaries) {
    if (summary.status !== "running") continue;
    try {
      const didRecover = await mutateSession(summary.id, (session) => {
        if (session.status !== "running") return SKIP_SESSION_WRITE;
        const now = new Date().toISOString();
        const priorRun = session.activeRun?.runId
          ? session.activeRun
          : {
              runId: crypto.randomUUID(),
              mode: session.mode || "collaboration",
              startedAt: session.updatedAt || now,
            };
        session.status = "interrupted";
        session.activeRun = {
          ...priorRun,
          status: "interrupted",
          endedAt: now,
          interruptionReason: reason,
        };
        const message = makeMessage({
          author: "system",
          content: "The previous discussion was interrupted because the server stopped.",
          phase: "interrupted",
          mode: session.mode,
        });
        message.meta = { recovery: true, runId: priorRun.runId };
        session.messages.push(message);
        return true;
      });
      if (didRecover) recovered += 1;
    } catch (error) {
      logError(`failed to reconcile interrupted discussion ${summary.id}`, redact(error?.message || String(error)));
    }
  }
  return recovered;
}

export function runOrchestration(sessionId, request, emit) {
  const validatedRequest = validateOrchestrationRequest(request);
  const releaseActivity = claimSessionActivity(sessionId, "orchestration");
  return runOrchestrationClaimed({ sessionId, request, validatedRequest, emit, releaseActivity });
}

async function runOrchestrationClaimed({ sessionId, request, validatedRequest, emit, releaseActivity }) {
  const state = createRunAttempt(validatedRequest.mode);
  // Keep the run's emitter and resource releasers on the attempt so a stop that has to
  // force-finalize a stalled run (see stopRun) can deliver the terminal SSE event AND release the
  // activity/project-scope claims — the suspended run body's own finally never runs in that case,
  // which would otherwise leave the session wedged as "busy" (409) until the process restarts.
  state.emit = emit;
  state.releaseActivity = releaseActivity;
  let releaseProjectScope = null;
  activeRuns.set(sessionId, state);
  const registerChild = (child) => {
    state.children.add(child);
    child.once("close", () => state.children.delete(child));
  };

  try {
    const session = await getSession(sessionId);
    const { mode, rounds, userTask, selected, finalizer } = validatedRequest;

    // When a project is attached, planning turns read it (read-only) from its git root,
    // grounded by one shared snapshot given to BOTH agents so they start from the same view.
    // Re-validate the path at run time (it may have been deleted/moved since attach) so we
    // fall back to text-only planning instead of failing the whole run on a bad cwd.
    let projectPath = session.project?.path || "";
    if (projectPath) {
      await assertTrustedProject(session);
      try { if (!(await fs.stat(projectPath)).isDirectory()) throw new Error("Attached project is no longer a directory"); }
      catch (error) { throw new Error(`Attached project is unavailable: ${error.message}`); }
    }
    const projSnapshot = projectPath ? await projectSnapshot(projectPath) : "";
    if (projectPath) {
      releaseProjectScope = await registerProjectScope(session.id, projectPath);
      state.releaseProjectScope = releaseProjectScope;
    }

    const connectorSessionId = Object.values(session.connectors || {}).some((item) => item.enabled) ? session.id : "";

    session.status = "running";
    session.mode = mode;
    session.settings = request;
    session.messages.push(makeMessage({ author: "user", content: userTask, phase: "user", mode }));
    session.messages.push(makeMessage({
      author: "system",
      content: `Session mode changed to ${mode}. Participants: ${selected.map((key) => provider(key).label).join(", ")}. Rounds: ${rounds}.`,
      phase: "mode_change",
      mode,
    }));
    if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
    emit({ type: "run_started", sessionId, runId: state.runId, mode, rounds });

    const callAgent = async (agent, prompt, round, phase) => {
      assertRunAcceptsOutput(sessionId, state);
      // Planning turns run inside the attached project (read-only) so they can read its
      // files; chat stays in the scratch workspace; unattached planning is text-only.
      const isDiscussion = phase === "collaboration" || phase === "opening" || phase === "rebuttal" || phase === "synthesis";
      const definition = provider(agent);
      const useProject = Boolean((isDiscussion || phase === "chat") && projectPath && definition.capabilities?.projectRead);
      const mcpProject = useProject && definition.capabilities?.projectTransport === "mcp";
      const connectorAccess = Boolean(!useProject && definition.capabilities?.connectors && connectorSessionId);
      const webOnly = phase === "chat" && !useProject && !connectorAccess && definition.capabilities?.web;
      const cfg = {
        ...request.agents[agent],
        permission: mcpProject ? "project" : useProject ? "planread" : connectorAccess ? "connectors" : webOnly ? "chat" : "read",
        mcpSessionId: connectorAccess || mcpProject ? session.id : "",
      };
      const cwd = useProject && !mcpProject ? projectPath : await scratchWorkspacePath();
      const role = String(cfg.role || (mode === "debate" ? "Debater" : "Collaborator"));
      const contextChars = prompt.length;
      const contextMessages = session.messages.length;
      emit({ type: "agent_start", sessionId, runId: state.runId, agent, label: provider(agent).label, role, round, phase });
      const deltaBuffer = new CappedText();
      let result;
      let providerPromise;
      try {
        providerPromise = Promise.resolve().then(() => definition.run({
          prompt,
          config: cfg,
          cwd,
          registerChild,
          onEvent(event) {
            if (!runAcceptsOutput(sessionId, state)) return;
            if (event.kind === "delta") {
              deltaBuffer.append(event.text);
            } else {
              const visibleEvent = event?.text ? { ...event, text: redact(event.text) } : event;
              emit({ type: "agent_activity", sessionId, runId: state.runId, agent, event: visibleEvent, round, phase });
            }
          },
        }));
        state.pending.add(providerPromise);
        result = await providerPromise;
      } catch (error) {
        const safeError = redact(error?.message || String(error));
        // Save any partial output, clearly labeled — never treat it as a final result.
        const partial = redact(String(error.partial || deltaBuffer.toString())).trim();
        if (partial && runAcceptsOutput(sessionId, state)) {
          const partialMsg = makeMessage({ author: "agent", agent, role, content: partial, round, phase, mode });
          partialMsg.meta = {
            requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
            durationMs: error.durationMs ?? null, exitCode: error.exitCode ?? null,
            status: "partial", contextChars, contextMessages, error: safeError,
            outputTruncated: Boolean(error.outputTruncated),
          };
          session.messages.push(partialMsg);
          await persistRunProgress(session, state, emit);
        }
        error.agentLabel = provider(agent).label;
        throw error;
      } finally {
        if (providerPromise) state.pending.delete(providerPromise);
      }
      assertRunAcceptsOutput(sessionId, state);
      // The CONVERGENCE control line is only requested (and only meaningful) in the
      // collaboration/debate turns — parse it for early-stop and strip it there. Chat and
      // synthesis replies never ask for it, so they're left exactly as the agent wrote them
      // (otherwise a chat answer that legitimately contains that line would be corrupted).
      const usesControl = round >= 2 && (phase === "collaboration" || phase === "rebuttal");
      const safeText = redact(result.text);
      const control = usesControl ? parseAgentControl(safeText) : null;
      const message = makeMessage({ author: "agent", agent, role, content: usesControl ? stripAgentControl(safeText) : safeText, round, phase, mode });
      message.control = control;
      message.convergence = control;
      message.meta = {
        requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
        reportedModel: result.model ?? null, durationMs: result.durationMs ?? null,
        exitCode: result.exitCode ?? null, status: "completed",
        contextChars, contextMessages, retryCount: 0,
        outputTruncated: Boolean(result.outputTruncated),
      };
      session.messages.push(message);
      if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
      emit({ type: "agent_complete", sessionId, runId: state.runId, agent, message, providerSessionId: result.sessionId || null });
      return message;
    };

    let completedRounds = 0;
    let itemRegistry = [];
    let lastAssessment = null;
    let officialOutcome = null;
    let proposalVersion = 1;

    if (mode === "chat") {
      // Simple chat: each agent answers the user independently, in parallel, one pass.
      const snapshot = structuredClone(session);
      await runParallel(selected.map((agent) => () => {
        const prompt = chatPrompt({
          session: snapshot,
          agentLabel: provider(agent).label,
          role: request.agents[agent].role,
          userTask,
          capabilities: {
            ...provider(agent).capabilities,
            web: Boolean(provider(agent).capabilities?.web && !projectPath && !connectorSessionId),
            projectRead: Boolean(projectPath && provider(agent).capabilities?.projectRead),
          },
          projectSnapshot: projSnapshot,
        });
        return callAgent(agent, prompt, 1, "chat");
      }), state);
    } else if (mode === "collaboration") {
      for (let round = 1; round <= rounds; round += 1) {
        if (round === 1) {
          const openingSession = structuredClone(session);
          await runParallel(selected.map((agent) => () => {
            const prompt = collaborationPrompt({
              session: openingSession,
              agentLabel: provider(agent).label,
              role: request.agents[agent].role,
              round,
              totalRounds: rounds,
              userTask,
              projectSnapshot: projSnapshot,
            });
            return callAgent(agent, prompt, round, "collaboration");
          }), state);
          completedRounds = round;
          continue;
        }
        const snapshot = structuredClone(session);
        const targetVersion = proposalVersion;
        const roundMessages = await runParallel(selected.map((agent) => () => {
          const prompt = collaborationPrompt({
            session: snapshot,
            agentLabel: provider(agent).label,
            role: request.agents[agent].role,
            round,
            totalRounds: rounds,
            userTask,
            projectSnapshot: projSnapshot,
            targetVersion,
            itemRegistry,
          });
          return callAgent(agent, prompt, round, "collaboration");
        }), state);
        const assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry);
        lastAssessment = assessment;
        itemRegistry = assessment.itemRegistry;
        completedRounds = round;
        if (assessment.proposalChanged) proposalVersion += 1;
        else if (assessment.canStop) break;
      }
    } else {
      const openingSession = structuredClone(session);
      await runParallel(selected.map((agent) => () => {
        const opponent = selected.find((key) => key !== agent);
        const prompt = debatePrompt({
          session: openingSession,
          agentLabel: provider(agent).label,
          role: request.agents[agent].role,
          opponentLabel: provider(opponent).label,
          round: 1,
          totalRounds: rounds,
          userTask,
          independent: true,
          projectSnapshot: projSnapshot,
        });
        return callAgent(agent, prompt, 1, "opening");
      }), state);
      completedRounds = 1;

      for (let round = 2; round <= rounds; round += 1) {
        const snapshot = structuredClone(session);
        const targetVersion = proposalVersion;
        const roundMsgs = await runParallel(selected.map((agent) => () => {
          const opponent = selected.find((key) => key !== agent);
          const prompt = debatePrompt({
            session: snapshot,
            agentLabel: provider(agent).label,
            role: request.agents[agent].role,
            opponentLabel: provider(opponent).label,
            round,
            totalRounds: rounds,
            userTask,
            independent: false,
            projectSnapshot: projSnapshot,
            targetVersion,
            itemRegistry,
          });
          return callAgent(agent, prompt, round, "rebuttal");
        }), state);
        const assessment = assessRound(roundMsgs.map((message) => message.control), targetVersion, itemRegistry);
        lastAssessment = assessment;
        itemRegistry = assessment.itemRegistry;
        completedRounds = round;
        if (assessment.proposalChanged) proposalVersion += 1;
        else if (assessment.canStop) break;
      }
    }

    // Persist the deterministic outcome before asking the finalizer to explain it.
    if (!runWasCancelled(state) && mode !== "chat" && rounds >= 2 && lastAssessment) {
      officialOutcome = buildDiscussionOutcome(lastAssessment, rounds, completedRounds);
      const outcomeMessage = makeMessage({
        author: "system",
        content: discussionOutcomeReport(officialOutcome),
        phase: officialOutcome.phase,
        mode,
      });
      outcomeMessage.meta = { outcome: officialOutcome };
      session.messages.push(outcomeMessage);
      if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
    }

    if (mode !== "chat" && finalizer && finalizer !== "none" && selected.includes(finalizer) && !runWasCancelled(state)) {
      const prompt = synthesisPrompt({
        session,
        agentLabel: provider(finalizer).label,
        role: request.agents[finalizer].role,
        userTask,
        mode,
        projectSnapshot: projSnapshot,
        outcome: officialOutcome,
      });
      await callAgent(finalizer, prompt, completedRounds + 1, "synthesis");
    }

    const terminalStatus = runWasCancelled(state) ? "stopped" : "completed";
    if (claimRunTerminal(state, terminalStatus)) {
      session.status = terminalStatus;
      try {
        await persistRunTerminal(session, state, emit);
      } catch (persistError) {
        // We already own the terminal transition, so the outer catch can no longer re-claim it
        // (claimRunTerminal is one-shot). Surface the durable-write failure as run_error here so
        // the client still gets a terminal event; startup reconciliation repairs the on-disk
        // status on the next run instead of the session appearing to hang.
        logError("failed to persist completed discussion state", redact(persistError?.message || String(persistError)));
        emit({ type: "run_error", sessionId, runId: state.runId, error: redact(persistError?.message || String(persistError)) });
        return;
      }
      emit({
        type: terminalStatus === "stopped" ? "run_stopped" : "run_complete",
        sessionId,
        runId: state.runId,
      });
    }
  } catch (error) {
    const safeError = redact(error?.message || String(error));
    const terminalStatus = runWasCancelled(state) ? "stopped" : "error";
    if (claimRunTerminal(state, terminalStatus)) {
      try {
        const session = await getSession(sessionId);
        session.status = terminalStatus;
        const failMsg = makeMessage({
          author: "system",
          content: terminalStatus === "stopped" ? "Run stopped by user." : `فشل التشغيل: ${safeError}`,
          phase: terminalStatus,
          mode: session.mode,
        });
        if (terminalStatus !== "stopped") {
          failMsg.meta = {
            status: "error",
            error: safeError,
            agent: error.agentLabel || null,
            durationMs: error.durationMs ?? null,
            technical: error.technical ? redact(String(error.technical)).slice(0, 6000) : null,
          };
        }
        session.messages.push(failMsg);
        await persistRunTerminal(session, state, emit);
      } catch (persistenceError) {
        logError("failed to persist terminal discussion state", redact(persistenceError?.message || String(persistenceError)));
      }
      emit({
        type: terminalStatus === "stopped" ? "run_stopped" : "run_error",
        sessionId,
        runId: state.runId,
        error: safeError,
      });
    }
  } finally {
    try {
      releaseProjectScope?.();
      await Promise.all([...state.children].map((child) => terminateProcess(child)));
    } finally {
      if (activeRuns.get(sessionId) === state) activeRuns.delete(sessionId);
      releaseActivity();
    }
  }
}
