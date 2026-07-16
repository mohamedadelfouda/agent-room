import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildDiscussionOutcome,
  discussionOutcomeReport,
  isRunning,
  mergeOrchestrationContent,
  reconcileInterruptedRuns,
  runOrchestration,
  stopRun,
  validateOrchestrationRequest,
} from "../../server/orchestrator.js";
import { createSession, getSession, mutateSession, rootPath } from "../../server/store.js";
import { provider } from "../../server/providers/registry.js";
import { claimSessionActivity } from "../../server/session-activity.js";

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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function providerResult(text) {
  return { text, model: "test", durationMs: 1, exitCode: 0, sessionId: null };
}

function chatRequest(content) {
  return {
    mode: "chat",
    rounds: 1,
    content,
    finalizer: "none",
    agents: {
      claude: { enabled: true, role: "Collaborator" },
      codex: { enabled: true, role: "Collaborator" },
    },
  };
}

function collaborationRequest(content) {
  return { ...chatRequest(content), mode: "collaboration" };
}

async function nextEventLoopTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function drainSessionWrites(sessionId) {
  await nextEventLoopTurn();
  await mutateSession(sessionId, () => {});
}

function assertSingleRunIdentity(events) {
  const runIds = new Set(events.map((event) => event.runId));
  assert.equal(runIds.size, 1);
  assert.match([...runIds][0], /^[0-9a-f-]{36}$/i);
}

async function cleanupSession(id) {
  const dir = join(rootPath(), "data", "sessions");
  await Promise.all([
    rm(join(dir, `${id}.json`), { force: true }),
    rm(join(dir, `${id}.summary.json`), { force: true }),
  ]);
}

test("orchestration content merge preserves concurrent state without authorizing a status transition", () => {
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

  const merged = mergeOrchestrationContent(latest, orchestration);
  assert.equal(merged.status, "running");
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
    assert.equal(saved.status, "completed");
    assert.equal(saved.activeRun.status, "completed");
    assert.ok(saved.activeRun.endedAt);
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

test("orchestration request validation rejects unsupported or inconsistent configurations", () => {
  const base = collaborationRequest("Validate this request");
  const cases = [
    ["unsupported mode", { ...base, mode: "parliament" }, "invalid_mode"],
    ["invalid rounds", { ...base, rounds: 0 }, "invalid_rounds"],
    ["one participant", { ...base, agents: { claude: { enabled: true } } }, "invalid_participants"],
    [
      "unknown enabled provider",
      { ...base, agents: { ...base.agents, cursor: { enabled: true } } },
      "invalid_provider",
    ],
    ["unselected finalizer", { ...base, finalizer: "cursor" }, "invalid_finalizer"],
    [
      "oversized role",
      {
        ...base,
        agents: {
          ...base.agents,
          claude: { ...base.agents.claude, role: "x".repeat(181) },
        },
      },
      "invalid_agent_role",
    ],
  ];

  for (const [label, request, expectedCode] of cases) {
    assert.throws(
      () => validateOrchestrationRequest(request),
      (error) => error.apiStatus === 400 && error.apiCode === expectedCode,
      label,
    );
  }
});

test("2026-07-16 regression: provider failure stays terminal after a late sibling result", async (t) => {
  const session = await createSession("provider-failure-race");
  const releaseCodex = deferred();
  const claudeFailed = deferred();
  const events = [];

  t.mock.method(provider("claude"), "run", async () => {
    claudeFailed.resolve();
    throw new Error("controlled provider failure");
  });
  t.mock.method(provider("codex"), "run", async () => {
    await releaseCodex.promise;
    return providerResult("late Codex response");
  });

  try {
    const runPromise = runOrchestration(session.id, chatRequest("Reproduce the provider race"), (event) => events.push(event));
    await claudeFailed.promise;
    await nextEventLoopTurn();
    releaseCodex.resolve();
    await runPromise;
    await drainSessionWrites(session.id);

    const saved = await getSession(session.id);
    assert.equal(saved.status, "error");
    assert.equal(saved.activeRun.status, "error");
    assert.ok(saved.activeRun.endedAt);
    assert.equal(saved.messages.some((message) => message.content === "late Codex response"), false);
    assert.equal(events.filter((event) => event.type === "run_error").length, 1);
    assert.equal(events.some((event) => event.type === "agent_complete" && event.agent === "codex"), false);
    assertSingleRunIdentity(events);
  } finally {
    releaseCodex.resolve();
    await cleanupSession(session.id);
  }
});

test("2026-07-16 regression: stopping a run rejects provider results that return during cancellation", async (t) => {
  const session = await createSession("provider-stop-race");
  const releaseClaude = deferred();
  const releaseCodex = deferred();
  const bothStarted = deferred();
  const events = [];
  let starts = 0;

  t.mock.method(provider("claude"), "run", async () => {
    await releaseClaude.promise;
    return providerResult("late Claude response");
  });
  t.mock.method(provider("codex"), "run", async () => {
    await releaseCodex.promise;
    return providerResult("late Codex response");
  });

  const runPromise = runOrchestration(session.id, chatRequest("Stop this run"), (event) => {
    events.push(event);
    if (event.type === "agent_start" && ++starts === 2) bothStarted.resolve();
  });

  try {
    await bothStarted.promise;
    const stopPromise = stopRun(session.id);
    await nextEventLoopTurn();
    releaseClaude.resolve();
    releaseCodex.resolve();
    assert.equal(await stopPromise, true);
    await runPromise;

    const saved = await getSession(session.id);
    assert.equal(saved.status, "stopped");
    assert.equal(saved.activeRun.status, "stopped");
    assert.equal(saved.messages.some((message) => message.meta?.status === "completed"), false);
    assert.equal(events.filter((event) => event.type === "agent_complete").length, 0);
    assert.equal(events.filter((event) => event.type === "run_stopped").length, 1);
    assertSingleRunIdentity(events);
  } finally {
    releaseClaude.resolve();
    releaseCodex.resolve();
    await runPromise;
    await cleanupSession(session.id);
  }
});

test("startup reconciliation terminalizes a stored running discussion exactly once", async () => {
  const session = await createSession("interrupted-discussion-recovery");
  const runId = "11111111-1111-4111-8111-111111111111";
  await mutateSession(session.id, (stored) => {
    stored.status = "running";
    stored.activeRun = {
      runId,
      mode: "collaboration",
      status: "running",
      startedAt: "2026-07-15T12:00:00.000Z",
    };
  });

  try {
    await reconcileInterruptedRuns("test_restart");
    await reconcileInterruptedRuns("test_restart");
    const saved = await getSession(session.id);
    assert.equal(saved.status, "interrupted");
    assert.equal(saved.activeRun.status, "interrupted");
    assert.equal(saved.activeRun.runId, runId);
    assert.equal(saved.activeRun.interruptionReason, "test_restart");
    assert.equal(saved.messages.filter((message) => message.meta?.recovery && message.meta.runId === runId).length, 1);
  } finally {
    await cleanupSession(session.id);
  }
});

test("first collaboration opinions start independently before either provider returns", async (t) => {
  const session = await createSession("independent-collaboration-opening");
  const claudeOpening = "CLAUDE_OPENING_MUST_NOT_REACH_CODEX";
  let codexPrompt = "";

  t.mock.method(provider("claude"), "run", async () => providerResult(claudeOpening));
  t.mock.method(provider("codex"), "run", async ({ prompt }) => {
    codexPrompt = prompt;
    return providerResult("Codex opening");
  });

  try {
    await runOrchestration(session.id, collaborationRequest("Collect independent opinions"), () => {});
    assert.doesNotMatch(codexPrompt, new RegExp(claudeOpening));
  } finally {
    await cleanupSession(session.id);
  }
});

test("2026-07-16 regression: a stop finalizes a run whose providers never settle", async (t) => {
  const session = await createSession("stop-settle-timeout");
  const bothStarted = deferred();
  // Providers stay pending (no child to kill) until the test releases them — a real stall in the
  // un-timed setup phase. Using a resolvable deferred (not an un-resolvable promise) lets the run
  // body unwind at the end, so the node:test runner is not left with a dangling promise.
  const releaseProviders = deferred();
  const events = [];
  let starts = 0;

  t.mock.method(provider("claude"), "run", async () => { await releaseProviders.promise; return providerResult("unreachable"); });
  t.mock.method(provider("codex"), "run", async () => { await releaseProviders.promise; return providerResult("unreachable"); });

  const runPromise = runOrchestration(session.id, chatRequest("Stop a stalled run"), (event) => {
    events.push(event);
    if (event.type === "agent_start" && ++starts === 2) bothStarted.resolve();
  });
  runPromise.catch(() => {});

  try {
    await bothStarted.promise;
    // The settle wait must give up quickly and force-finalize instead of leaving it "running".
    assert.equal(await stopRun(session.id, { settleTimeoutMs: 50 }), true);

    const saved = await getSession(session.id);
    assert.equal(saved.status, "stopped");
    assert.equal(saved.activeRun.status, "stopped");
    assert.equal(isRunning(session.id), false);
    // The activity claim must also be released, or the session stays wedged as 409 "busy" forever
    // even though it reads "stopped". Claiming + immediately releasing proves it is usable again.
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-stop-check")());
    assert.equal(events.filter((event) => event.type === "run_stopped").length, 1);
    assert.equal(events.some((event) => event.type === "agent_complete"), false);
    assertSingleRunIdentity(events);
  } finally {
    // Release the stalled providers so the run body unwinds (their late results are discarded
    // because the run is already terminal), then await it so no pending promise outlives the test.
    releaseProviders.resolve();
    await runPromise.catch(() => {});
    await cleanupSession(session.id);
  }
});
