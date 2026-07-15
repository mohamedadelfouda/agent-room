import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildDiscussionOutcome,
  discussionOutcomeReport,
  mergeOrchestrationState,
  runOrchestration,
} from "../../server/orchestrator.js";
import { createSession, getSession, rootPath } from "../../server/store.js";
import { provider } from "../../server/providers/registry.js";

function controlBlock(goalStatus, itemProposals) {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus,
    substantiveDelta: false,
    itemProposals,
    targetVersion: 1,
  })}</agent-control>`;
}

async function cleanupSession(id) {
  const dir = join(rootPath(), "data", "sessions");
  await Promise.all([
    rm(join(dir, `${id}.json`), { force: true }),
    rm(join(dir, `${id}.summary.json`), { force: true }),
  ]);
}

test("orchestration persistence preserves concurrent connector actions and decisions", () => {
  const latest = {
    id: "session-1",
    status: "running",
    mode: "collaboration",
    settings: { rounds: 2 },
    messages: [{ id: "old", createdAt: "2026-07-14T10:00:00.000Z", content: "old" }],
    connectorActions: [{ id: "proposal-1", status: "pending" }],
    decisions: [{ id: "decision-1", outcome: "approved" }],
  };
  const orchestration = {
    ...structuredClone(latest),
    status: "completed",
    settings: { rounds: 3 },
    messages: [
      { id: "old", createdAt: "2026-07-14T10:00:00.000Z", content: "old" },
      { id: "answer", createdAt: "2026-07-14T10:01:00.000Z", content: "answer" },
    ],
    connectorActions: [],
    decisions: [],
  };

  const merged = mergeOrchestrationState(latest, orchestration);
  assert.equal(merged.status, "completed");
  assert.deepEqual(merged.settings, { rounds: 3 });
  assert.deepEqual(merged.messages.map((message) => message.id), ["old", "answer"]);
  assert.deepEqual(merged.connectorActions, [{ id: "proposal-1", status: "pending" }]);
  assert.deepEqual(merged.decisions, [{ id: "decision-1", outcome: "approved" }]);
});

test("outcome reporting separates agreement from a pending user decision", () => {
  const assessment = {
    canStop: true,
    agreementState: "converged",
    completionState: "needs_user",
    stopReason: "user_decision",
    itemRegistry: [],
    pendingItems: [],
    pendingKinds: ["user_decision"],
    nextSteps: [],
    disagreements: [],
    unclassifiedPoints: [],
    conflicts: [],
    allValid: true,
  };
  const outcome = buildDiscussionOutcome(assessment, 5, 2);
  assert.equal(outcome.phase, "needs_user");
  assert.equal(outcome.stoppedEarly, true);
  assert.match(discussionOutcomeReport(outcome), /الوكلاء متفقون/);
  assert.doesNotMatch(discussionOutcomeReport(outcome), /مش متفقين|اختلاف جوهري/);
});

test("a five-round collaboration stops after round two and finalizes once", async (t) => {
  const session = await createSession("convergence-regression");
  let claudeCalls = 0;
  let codexCalls = 0;
  const result = (text) => ({ text, model: "test", durationMs: 1, exitCode: 0, sessionId: null });

  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return result("Claude opening proposal");
    if (claudeCalls === 2) {
      return result(`Claude agrees\n${controlBlock("needs_user", [{
        action: "create",
        kind: "user_decision",
        text: "Choose the rollout mode",
        requiredStep: { actor: "user", action: "provide_decision" },
      }])}`);
    }
    return result("الوكلاء غير متفقين — هذا نص finalizer متعمد أن يكون خاطئًا");
  });
  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    if (codexCalls === 1) return result("Codex opening proposal");
    return result(`Codex agrees\n${controlBlock("blocked", [{
      action: "create",
      kind: "external_validation",
      text: "Verify Cursor containment",
      requiredStep: { actor: "human_operator", action: "run_external_check" },
    }])}`);
  });

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 5,
      content: "Plan the change",
      finalizer: "claude",
      agents: {
        claude: { enabled: true, role: "Collaborator" },
        codex: { enabled: true, role: "Collaborator" },
      },
    }, () => {});

    const saved = await getSession(session.id);
    const discussion = saved.messages.filter((message) => message.phase === "collaboration");
    const synthesis = saved.messages.filter((message) => message.phase === "synthesis");
    const outcomeMessage = saved.messages.find((message) => message.meta?.outcome);
    assert.deepEqual([...new Set(discussion.map((message) => message.round))], [1, 2]);
    assert.equal(discussion.length, 4);
    assert.equal(synthesis.length, 1);
    assert.equal(outcomeMessage.phase, "blocked_external");
    assert.equal(outcomeMessage.meta.outcome.agreementState, "converged");
    assert.equal(outcomeMessage.meta.outcome.completionState, "blocked");
    assert.equal(outcomeMessage.meta.outcome.requestedRounds, 5);
    assert.equal(outcomeMessage.meta.outcome.completedRounds, 2);
    assert.deepEqual(new Set(outcomeMessage.meta.outcome.pendingKinds), new Set(["user_decision", "external_validation"]));
    assert.doesNotMatch(outcomeMessage.content, /مش متفقين/);
    assert.match(synthesis[0].content, /غير متفقين/);
    assert.equal(outcomeMessage.meta.outcome.agreementState, "converged");
  } finally {
    await cleanupSession(session.id);
  }
});
