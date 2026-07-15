import { getSession, mutateSession, scratchWorkspacePath } from "./store.js";
import { terminateProcess } from "./process.js";
import { provider, providerIds } from "./providers/registry.js";
import { collaborationPrompt, debatePrompt, synthesisPrompt, chatPrompt } from "./prompts.js";
import { parseAgentControl, stripAgentControl, assessRound } from "./convergence.js";
import { assertTrustedProject, projectSnapshot } from "./project.js";
import fs from "node:fs/promises";
import { CappedText } from "./output-limits.js";
import { redact } from "./logger.js";
import { registerProjectScope } from "./project-tools.js";
import { claimSessionActivity } from "./session-activity.js";

const activeRuns = new Map();
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

export function mergeOrchestrationState(latest, session) {
  // Connector MCP calls and user approvals can update the same session while an
  // agent is running. Merge messages by id instead of replacing those concurrent
  // connector/decision updates with this orchestration's older snapshot.
  const messages = new Map();
  for (const message of [...(latest.messages || []), ...(session.messages || [])]) messages.set(message.id, message);
  latest.messages = [...messages.values()].sort((a, b) => {
    const time = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    return time || String(a.id || "").localeCompare(String(b.id || ""));
  });
  latest.status = session.status;
  latest.mode = session.mode;
  latest.settings = structuredClone(session.settings || {});
  return latest;
}

async function persistAndEmit(session, emit) {
  await mutateSession(session.id, (latest) => {
    mergeOrchestrationState(latest, session);
  });
  emit({ type: "session_updated", sessionId: session.id });
}

export async function stopRun(sessionId) {
  const state = activeRuns.get(sessionId);
  if (!state) return false;
  state.cancelled = true;
  const results = await Promise.all([...state.children].map((child) => terminateProcess(child)));
  return results.every(Boolean);
}

export function isRunning(sessionId) {
  return activeRuns.has(sessionId);
}

// Stop every in-flight run and mark its session interrupted — used during graceful shutdown
// so we never leave a session stuck in "running" after the process exits.
export async function abortAllRuns(reason = "server_shutdown") {
  for (const [sessionId, state] of activeRuns) {
    state.cancelled = true;
    // Shutdown path: SIGKILL now (see terminateProcess) so a detached agent can't outlive the
    // server's ~1500ms exit, which would otherwise beat the SIGTERM→SIGKILL escalation timer.
    await Promise.all([...state.children].map((child) => terminateProcess(child, { immediate: true })));
    try {
      await mutateSession(sessionId, (session) => {
        session.status = "interrupted";
        session.messages.push(makeMessage({
          author: "system",
          content: `تم إيقاف التشغيل بشكل مفاجئ: ${reason}`,
          phase: "interrupted",
          mode: session.mode,
        }));
      });
    } catch {}
  }
}

export function runOrchestration(sessionId, request, emit) {
  const releaseActivity = claimSessionActivity(sessionId, "orchestration");
  return runOrchestrationClaimed(sessionId, request, emit, releaseActivity);
}

async function runOrchestrationClaimed(sessionId, request, emit, releaseActivity) {
  const state = { cancelled: false, children: new Set() };
  let releaseProjectScope = null;
  activeRuns.set(sessionId, state);
  const registerChild = (child) => {
    state.children.add(child);
    child.once("close", () => state.children.delete(child));
  };

  try {
    const session = await getSession(sessionId);
    const mode = request.mode === "debate" ? "debate" : request.mode === "chat" ? "chat" : "collaboration";
    const rounds = Math.max(1, Math.min(5, Number(request.rounds) || 2));
    const userTask = String(request.content || "").trim();
    if (!userTask) throw new Error("Write a message first");

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
    if (projectPath) releaseProjectScope = await registerProjectScope(session.id, projectPath);

    const selected = providerIds().filter((key) => request.agents?.[key] && request.agents[key].enabled !== false);
    if (selected.length < 2) throw new Error("Enable at least two providers for this mode");
    if (mode === "debate" && selected.length !== 2) throw new Error("Debate mode requires exactly two providers");
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
    await persistAndEmit(session, emit);
    emit({ type: "run_started", sessionId, mode, rounds });

    const callAgent = async (agent, prompt, round, phase) => {
      if (state.cancelled) throw new Error("Run stopped by user");
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
      emit({ type: "agent_start", sessionId, agent, label: provider(agent).label, role, round, phase });
      const deltaBuffer = new CappedText();
      let result;
      try {
        result = await provider(agent).run({
          prompt,
          config: cfg,
          cwd,
          registerChild,
          onEvent(event) {
            if (event.kind === "delta") {
              deltaBuffer.append(event.text);
            } else {
              const visibleEvent = event?.text ? { ...event, text: redact(event.text) } : event;
              emit({ type: "agent_activity", sessionId, agent, event: visibleEvent, round, phase });
            }
          },
        });
      } catch (error) {
        const safeError = redact(error?.message || String(error));
        // Save any partial output, clearly labeled — never treat it as a final result.
        const partial = redact(String(error.partial || deltaBuffer.toString())).trim();
        if (partial) {
          const partialMsg = makeMessage({ author: "agent", agent, role, content: partial, round, phase, mode });
          partialMsg.meta = {
            requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
            durationMs: error.durationMs ?? null, exitCode: error.exitCode ?? null,
            status: "partial", contextChars, contextMessages, error: safeError,
            outputTruncated: Boolean(error.outputTruncated),
          };
          session.messages.push(partialMsg);
          await persistAndEmit(session, emit);
        }
        error.agentLabel = provider(agent).label;
        throw error;
      }
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
      await persistAndEmit(session, emit);
      emit({ type: "agent_complete", sessionId, agent, message, providerSessionId: result.sessionId || null });
      return message;
    };

    let earlyConverged = 0;
    let lastDisagreements = [];
    let proposalVersion = 1;

    if (mode === "chat") {
      // Simple chat: each agent answers the user independently, in parallel, one pass.
      const snapshot = structuredClone(session);
      await Promise.all(selected.map((agent) => {
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
      }));
    } else if (mode === "collaboration") {
      for (let round = 1; round <= rounds; round += 1) {
        if (round === 1) {
          for (const agent of selected) {
            const prompt = collaborationPrompt({
              session,
              agentLabel: provider(agent).label,
              role: request.agents[agent].role,
              round,
              totalRounds: rounds,
              userTask,
              projectSnapshot: projSnapshot,
            });
            await callAgent(agent, prompt, round, "collaboration");
          }
          continue;
        }
        const snapshot = structuredClone(session);
        const targetVersion = proposalVersion;
        const roundMessages = await Promise.all(selected.map((agent) => {
          const prompt = collaborationPrompt({
            session: snapshot,
            agentLabel: provider(agent).label,
            role: request.agents[agent].role,
            round,
            totalRounds: rounds,
            userTask,
            projectSnapshot: projSnapshot,
            targetVersion,
          });
          return callAgent(agent, prompt, round, "collaboration");
        }));
        const assessment = assessRound(roundMessages.map((message) => message.control), targetVersion);
        lastDisagreements = assessment.disagreements;
        if (assessment.proposalChanged) proposalVersion += 1;
        else if (assessment.canStop) { earlyConverged = round; break; }
      }
    } else {
      const openingSession = structuredClone(session);
      await Promise.all(selected.map((agent) => {
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
      }));

      for (let round = 2; round <= rounds; round += 1) {
        const snapshot = structuredClone(session);
        const targetVersion = proposalVersion;
        const roundMsgs = await Promise.all(selected.map((agent) => {
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
          });
          return callAgent(agent, prompt, round, "rebuttal");
        }));
        const assessment = assessRound(roundMsgs.map((message) => message.control), targetVersion);
        lastDisagreements = assessment.disagreements;
        if (assessment.proposalChanged) proposalVersion += 1;
        else if (assessment.canStop) { earlyConverged = round; break; }
      }
    }

    // Early-stop / disagreement report (multi-round collaboration & debate only).
    if (!state.cancelled && mode !== "chat" && rounds >= 2) {
      let report = null;
      if (earlyConverged) {
        report = earlyConverged < rounds
          ? { content: `الوكلاء اتفقوا في الجولة ${earlyConverged} — تم إيقاف الجولات المتبقية.`, phase: "converged" }
          : { content: `الوكلاء اتفقوا في الجولة الأخيرة (${earlyConverged}).`, phase: "converged" };
      } else if (lastDisagreements.length) {
        const list = lastDisagreements.map((d) => `• ${d}`).join("\n");
        report = { content: `خلصت الـ${rounds} جولات والوكلاء لسه مش متفقين. نقاط الاختلاف:\n${list}\n\nمحتاجين جولات إضافية؟`, phase: "needs_more_rounds" };
      } else {
        // Finished all rounds without agreement and without articulated points (e.g. markers missing).
        report = { content: `خلصت الـ${rounds} جولات من غير اتفاق واضح بين الوكلاء. تحب جولات إضافية؟`, phase: "needs_more_rounds" };
      }
      session.messages.push(makeMessage({ author: "system", content: report.content, phase: report.phase, mode }));
      await persistAndEmit(session, emit);
    }

    const finalizer = request.finalizer;
    if (mode !== "chat" && finalizer && finalizer !== "none" && selected.includes(finalizer) && !state.cancelled) {
      const prompt = synthesisPrompt({
        session,
        agentLabel: provider(finalizer).label,
        role: request.agents[finalizer].role,
        userTask,
        mode,
        projectSnapshot: projSnapshot,
      });
      await callAgent(finalizer, prompt, rounds + 1, "synthesis");
    }

    session.status = state.cancelled ? "stopped" : "completed";
    await persistAndEmit(session, emit);
    emit({ type: state.cancelled ? "run_stopped" : "run_complete", sessionId });
  } catch (error) {
    const safeError = redact(error?.message || String(error));
    try {
      const session = await getSession(sessionId);
      session.status = state.cancelled ? "stopped" : "error";
      const failMsg = makeMessage({
        author: "system",
        content: state.cancelled ? "Run stopped by user." : `فشل التشغيل: ${safeError}`,
        phase: state.cancelled ? "stopped" : "error",
        mode: session.mode,
      });
      if (!state.cancelled) {
        failMsg.meta = {
          status: "error",
          error: safeError,
          agent: error.agentLabel || null,
          durationMs: error.durationMs ?? null,
          technical: error.technical ? redact(String(error.technical)).slice(0, 6000) : null,
        };
      }
      session.messages.push(failMsg);
      await persistAndEmit(session, emit);
    } catch {}
    emit({ type: state.cancelled ? "run_stopped" : "run_error", sessionId, error: safeError });
  } finally {
    try {
      releaseProjectScope?.();
      await Promise.all([...state.children].map((child) => terminateProcess(child)));
    } finally {
      activeRuns.delete(sessionId);
      releaseActivity();
    }
  }
}
