import { getSession, saveSession } from "./store.js";
import { rootPath } from "./store.js";
import { terminateProcess } from "./process.js";
import { runCodex } from "./adapters/codex.js";
import { runClaude } from "./adapters/claude.js";
import { collaborationPrompt, debatePrompt, synthesisPrompt, chatPrompt } from "./prompts.js";
import { parseConvergence, stripConvergence, assessRound } from "./convergence.js";

const activeRuns = new Map();
const adapters = { codex: runCodex, claude: runClaude };
const labels = { codex: "Codex", claude: "Claude" };

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

async function persistAndEmit(session, emit) {
  await saveSession(session);
  emit({ type: "session_updated", sessionId: session.id });
}

export function stopRun(sessionId) {
  const state = activeRuns.get(sessionId);
  if (!state) return false;
  state.cancelled = true;
  for (const child of state.children) terminateProcess(child);
  return true;
}

export function isRunning(sessionId) {
  return activeRuns.has(sessionId);
}

// Stop every in-flight run and mark its session interrupted — used during graceful shutdown
// so we never leave a session stuck in "running" after the process exits.
export async function abortAllRuns(reason = "server_shutdown") {
  for (const [sessionId, state] of activeRuns) {
    state.cancelled = true;
    for (const child of state.children) terminateProcess(child);
    try {
      const session = await getSession(sessionId);
      session.status = "interrupted";
      session.messages.push(makeMessage({
        author: "system",
        content: `تم إيقاف التشغيل بشكل مفاجئ: ${reason}`,
        phase: "interrupted",
        mode: session.mode,
      }));
      await saveSession(session);
    } catch {}
  }
}

export async function runOrchestration(sessionId, request, emit) {
  if (activeRuns.has(sessionId)) throw new Error("This session is already running");
  const state = { cancelled: false, children: new Set() };
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

    const selected = ["codex", "claude"].filter((key) => request.agents?.[key]?.enabled !== false);
    if (selected.length < 2) throw new Error("Enable Codex and Claude for this MVP");

    session.status = "running";
    session.mode = mode;
    session.settings = request;
    session.messages.push(makeMessage({ author: "user", content: userTask, phase: "user", mode }));
    session.messages.push(makeMessage({
      author: "system",
      content: `Session mode changed to ${mode}. Participants: ${selected.map((key) => labels[key]).join(", ")}. Rounds: ${rounds}.`,
      phase: "mode_change",
      mode,
    }));
    await persistAndEmit(session, emit);
    emit({ type: "run_started", sessionId, mode, rounds });

    const callAgent = async (agent, prompt, round, phase) => {
      if (state.cancelled) throw new Error("Run stopped by user");
      const cfg = phase === "chat" ? { ...request.agents[agent], permission: "chat" } : request.agents[agent];
      const role = String(cfg.role || (mode === "debate" ? "Debater" : "Collaborator"));
      const contextChars = prompt.length;
      const contextMessages = session.messages.length;
      emit({ type: "agent_start", sessionId, agent, label: labels[agent], role, round, phase });
      let deltaBuffer = "";
      let result;
      try {
        result = await adapters[agent]({
          prompt,
          config: cfg,
          cwd: `${rootPath()}/workspace`,
          registerChild,
          onEvent(event) {
            if (event.kind === "delta") {
              deltaBuffer += event.text;
              emit({ type: "agent_delta", sessionId, agent, text: event.text, round, phase });
            } else {
              emit({ type: "agent_activity", sessionId, agent, event, round, phase });
            }
          },
        });
      } catch (error) {
        // Save any partial output, clearly labeled — never treat it as a final result.
        const partial = String(error.partial || deltaBuffer || "").trim();
        if (partial) {
          const partialMsg = makeMessage({ author: "agent", agent, role, content: partial, round, phase, mode });
          partialMsg.meta = {
            requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
            durationMs: error.durationMs ?? null, exitCode: error.exitCode ?? null,
            status: "partial", contextChars, contextMessages, error: error.message,
          };
          session.messages.push(partialMsg);
          await persistAndEmit(session, emit);
        }
        error.agentLabel = labels[agent];
        throw error;
      }
      // Pull the CONVERGENCE control line out of the reply (used for early-stop) and hide
      // it from the shown message. Only meaningful in collaboration/debate.
      const convergence = parseConvergence(result.text);
      const message = makeMessage({ author: "agent", agent, role, content: stripConvergence(result.text), round, phase, mode });
      message.convergence = convergence;
      message.meta = {
        requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
        reportedModel: result.model ?? null, durationMs: result.durationMs ?? null,
        exitCode: result.exitCode ?? null, status: "completed",
        contextChars, contextMessages, retryCount: 0,
      };
      session.messages.push(message);
      await persistAndEmit(session, emit);
      emit({ type: "agent_complete", sessionId, agent, message, providerSessionId: result.sessionId || null });
      return message;
    };

    let earlyConverged = 0;
    let lastDisagreements = [];

    if (mode === "chat") {
      // Simple chat: each agent answers the user independently, in parallel, one pass.
      const snapshot = structuredClone(session);
      await Promise.all(selected.map((agent) => {
        const prompt = chatPrompt({
          session: snapshot,
          agentLabel: labels[agent],
          role: request.agents[agent].role,
          userTask,
        });
        return callAgent(agent, prompt, 1, "chat");
      }));
    } else if (mode === "collaboration") {
      for (let round = 1; round <= rounds; round += 1) {
        const roundMsgs = [];
        for (const agent of selected) {
          const prompt = collaborationPrompt({
            session,
            agentLabel: labels[agent],
            role: request.agents[agent].role,
            round,
            totalRounds: rounds,
            userTask,
          });
          roundMsgs.push(await callAgent(agent, prompt, round, "collaboration"));
        }
        // From round 2 on (both have seen each other), stop early if both agents agree.
        if (round >= 2) {
          const r = assessRound(roundMsgs.map((m) => m.convergence));
          lastDisagreements = r.disagreements;
          if (r.bothConverged) { earlyConverged = round; break; }
        }
      }
    } else {
      const openingSession = structuredClone(session);
      await Promise.all(selected.map((agent) => {
        const opponent = selected.find((key) => key !== agent);
        const prompt = debatePrompt({
          session: openingSession,
          agentLabel: labels[agent],
          role: request.agents[agent].role,
          opponentLabel: labels[opponent],
          round: 1,
          totalRounds: rounds,
          userTask,
          independent: true,
        });
        return callAgent(agent, prompt, 1, "opening");
      }));

      for (let round = 2; round <= rounds; round += 1) {
        const snapshot = structuredClone(session);
        const roundMsgs = await Promise.all(selected.map((agent) => {
          const opponent = selected.find((key) => key !== agent);
          const prompt = debatePrompt({
            session: snapshot,
            agentLabel: labels[agent],
            role: request.agents[agent].role,
            opponentLabel: labels[opponent],
            round,
            totalRounds: rounds,
            userTask,
            independent: false,
          });
          return callAgent(agent, prompt, round, "rebuttal");
        }));
        const r = assessRound(roundMsgs.map((m) => m.convergence));
        lastDisagreements = r.disagreements;
        if (r.bothConverged) { earlyConverged = round; break; }
      }
    }

    // Early-stop / disagreement report (collaboration & debate only).
    if (earlyConverged) {
      session.messages.push(makeMessage({ author: "system", content: `الوكيلان اتفقا في الجولة ${earlyConverged} — تم إيقاف الجولات المتبقية.`, phase: "converged", mode }));
      await persistAndEmit(session, emit);
    } else if (mode !== "chat" && rounds >= 2 && lastDisagreements.length) {
      const list = lastDisagreements.map((d) => `• ${d}`).join("\n");
      session.messages.push(makeMessage({ author: "system", content: `خلصت الـ${rounds} جولات والوكيلان لسه مش متفقين. نقاط الاختلاف:\n${list}\n\nمحتاجين جولات إضافية؟`, phase: "needs_more_rounds", mode }));
      await persistAndEmit(session, emit);
    }

    const finalizer = request.finalizer;
    if (mode !== "chat" && finalizer && finalizer !== "none" && selected.includes(finalizer) && !state.cancelled) {
      const prompt = synthesisPrompt({
        session,
        agentLabel: labels[finalizer],
        role: request.agents[finalizer].role,
        userTask,
        mode,
      });
      await callAgent(finalizer, prompt, rounds + 1, "synthesis");
    }

    session.status = state.cancelled ? "stopped" : "completed";
    await persistAndEmit(session, emit);
    emit({ type: state.cancelled ? "run_stopped" : "run_complete", sessionId });
  } catch (error) {
    try {
      const session = await getSession(sessionId);
      session.status = state.cancelled ? "stopped" : "error";
      const failMsg = makeMessage({
        author: "system",
        content: state.cancelled ? "Run stopped by user." : `فشل التشغيل: ${error.message}`,
        phase: state.cancelled ? "stopped" : "error",
        mode: session.mode,
      });
      if (!state.cancelled) {
        failMsg.meta = {
          status: "error",
          error: error.message,
          agent: error.agentLabel || null,
          durationMs: error.durationMs ?? null,
          technical: error.technical ? String(error.technical).slice(0, 6000) : null,
        };
      }
      session.messages.push(failMsg);
      await persistAndEmit(session, emit);
    } catch {}
    emit({ type: state.cancelled ? "run_stopped" : "run_error", sessionId, error: error.message });
  } finally {
    for (const child of state.children) terminateProcess(child);
    activeRuns.delete(sessionId);
  }
}
