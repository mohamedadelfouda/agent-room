import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentControl, stripAgentControl, assessRound } from "../../server/convergence.js";

function legacyBlock(overrides = {}) {
  return `<agent-control>${JSON.stringify({
    convergence: "converged",
    goalStatus: "satisfied",
    substantiveDelta: false,
    openPoints: [],
    confidence: 0.9,
    targetVersion: 2,
    ...overrides,
  })}</agent-control>`;
}

function block(overrides = {}) {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus: "satisfied",
    substantiveDelta: false,
    itemProposals: [],
    targetVersion: 2,
    ...overrides,
  })}</agent-control>`;
}

function control(overrides = {}) {
  return parseAgentControl(block(overrides));
}

function create(kind, text, actor, action) {
  return { action: "create", kind, text, requiredStep: { actor, action } };
}

function item(itemId, kind, text, actor, action, status = "open") {
  return { itemId, kind, status, text, requiredStep: { actor, action } };
}

test("parseAgentControl accepts the version 2 proposal contract", () => {
  const parsed = parseAgentControl(`reader-facing answer\n${block({
    goalStatus: "needs_user",
    itemProposals: [create("user_decision", "Choose a mode", "user", "provide_decision")],
  })}`);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.controlVersion, 2);
  assert.equal(parsed.itemProposals[0].action, "create");
  assert.equal(parsed.confidence, null);
});

test("legacy controls remain readable without treating open points as categorized items", () => {
  const parsed = parseAgentControl(legacyBlock({ openPoints: ["scope"] }));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.controlVersion, 1);
  assert.deepEqual(parsed.openPoints, ["scope"]);
  assert.deepEqual(parsed.itemProposals, []);
});

test("missing, malformed, embedded, and schema-invalid controls fail closed", () => {
  const invalidTexts = [
    "reader-facing answer only",
    "<agent-control>{not json}</agent-control>",
    `${block()}\nextra text`,
    block({ confidence: 0.9 }),
    block({ openPoints: [] }),
    block({ targetVersion: 0 }),
    block({ itemProposals: [create("user_decision", "Choose", "agent", "provide_decision")] }),
    block({ itemProposals: [{ action: "merge_into", itemId: "item-001", targetItemId: "item-001" }] }),
    block({ itemProposals: [{ action: "resolve", itemId: "item-001" }, { action: "keep_open", itemId: "item-001" }] }),
  ];
  for (const text of invalidTexts) {
    const parsed = parseAgentControl(text);
    assert.equal(parsed.valid, false);
    assert.equal(parsed.goalStatus, "incomplete");
  }
});

test("the final control block is authoritative and all blocks are stripped", () => {
  const text = `answer\n${block({ convergence: "open", goalStatus: "incomplete" })}\ncorrection\n${block()}`;
  assert.equal(parseAgentControl(text).convergence, "converged");
  assert.equal(stripAgentControl(text), "answer\n\ncorrection");
});

test("a complete aligned round stops with an empty official registry", () => {
  const result = assessRound([control(), control()], 2);
  assert.equal(result.canStop, true);
  assert.equal(result.agreementState, "converged");
  assert.equal(result.completionState, "satisfied");
  assert.equal(result.stopReason, "complete");
  assert.deepEqual(result.itemRegistry, []);
});

test("a user decision stops discussion and produces one derived next step", () => {
  const result = assessRound([
    control({ goalStatus: "needs_user", itemProposals: [create("user_decision", "Choose the rollout mode", "user", "provide_decision")] }),
    control({ goalStatus: "needs_user", itemProposals: [create("user_decision", "choose the rollout mode.", "user", "provide_decision")] }),
  ], 2);
  assert.equal(result.canStop, true);
  assert.equal(result.completionState, "needs_user");
  assert.equal(result.stopReason, "user_decision");
  assert.equal(result.itemRegistry.length, 1);
  assert.deepEqual(result.nextSteps, [{ actor: "user", action: "provide_decision", itemIds: ["item-001"] }]);
});

test("multiple pending kinds are preserved while completion stays conservative", () => {
  const result = assessRound([
    control({
      goalStatus: "blocked",
      itemProposals: [create("external_validation", "Verify containment", "human_operator", "run_external_check")],
    }),
    control({
      goalStatus: "needs_user",
      itemProposals: [create("user_decision", "Choose the provider", "user", "provide_decision")],
    }),
  ], 2);
  assert.equal(result.canStop, true);
  assert.equal(result.completionState, "blocked");
  assert.deepEqual(new Set(result.pendingKinds), new Set(["external_validation", "user_decision"]));
  assert.equal(result.nextSteps.length, 2);
});

test("an external follow-up does not imply blocked unless a control reports blocked", () => {
  const result = assessRound([
    control({ itemProposals: [create("external_validation", "Measure token use later", "orchestrator", "run_external_check")] }),
    control(),
  ], 2);
  assert.equal(result.completionState, "satisfied");
  assert.equal(result.stopReason, "complete");
  assert.equal(result.canStop, true);
  assert.deepEqual(result.pendingKinds, ["external_validation"]);
});

test("incomplete work, genuine disagreement, and substantive changes continue", () => {
  const incomplete = assessRound([control({ goalStatus: "incomplete" }), control({ goalStatus: "incomplete" })], 2);
  assert.equal(incomplete.agreementState, "converged");
  assert.equal(incomplete.canStop, false);

  const disagreementProposal = create("disagreement", "The permission boundary is unresolved", "agent", "resume_agent_round");
  const disagreement = assessRound([
    control({ convergence: "open", goalStatus: "incomplete", itemProposals: [disagreementProposal] }),
    control({ convergence: "open", goalStatus: "incomplete" }),
  ], 2);
  assert.equal(disagreement.agreementState, "open");
  assert.deepEqual(disagreement.disagreements, ["The permission boundary is unresolved"]);
  assert.equal(disagreement.canStop, false);

  const changed = assessRound([control({ substantiveDelta: true }), control()], 2);
  assert.equal(changed.proposalChanged, true);
  assert.equal(changed.canStop, false);
});

test("missing, invalid, stale, and round-inconsistent controls fail closed", () => {
  const valid = control();
  const cases = [
    [assessRound([valid], 2), "missing participant"],
    [assessRound([valid, parseAgentControl("bad")], 2), "invalid control"],
    [assessRound([valid, control({ targetVersion: 1 })], 2), "stale control"],
    [assessRound([control({ goalStatus: "needs_user" }), control({ goalStatus: "needs_user" })], 2), "missing user item"],
    [assessRound([control({ goalStatus: "blocked" }), control({ goalStatus: "blocked" })], 2), "missing external item"],
    [assessRound([valid, valid], 2, [{
      ...item("item-001", "external_validation", "Corrupt merge", "human_operator", "run_external_check", "superseded"),
      mergedIntoId: "item-001",
    }]), "cyclic registry"],
  ];
  for (const [result, label] of cases) {
    assert.equal(result.canStop, false, label);
    assert.equal(result.stopReason, "invalid_control", label);
    assert.equal(result.agreementState, "unknown", label);
  }
});

test("legacy open points fail closed without being relabeled as disagreement", () => {
  const legacy = parseAgentControl(legacyBlock({ openPoints: ["scope"] }));
  const result = assessRound([legacy, legacy], 2);
  assert.equal(result.canStop, false);
  assert.equal(result.agreementState, "unknown");
  assert.deepEqual(result.disagreements, []);
  assert.deepEqual(result.unclassifiedPoints, ["scope"]);
});

test("official items close only when every participant proposes resolution", () => {
  const registry = [item("item-001", "user_decision", "Choose a mode", "user", "provide_decision")];
  const resolved = assessRound([
    control({ itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
    control({ itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
  ], 2, registry);
  assert.equal(resolved.itemRegistry[0].status, "resolved");
  assert.equal(resolved.canStop, true);

  const disputed = assessRound([
    control({ goalStatus: "needs_user", itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
    control({ goalStatus: "needs_user", itemProposals: [{ action: "keep_open", itemId: "item-001" }] }),
  ], 2, registry);
  assert.equal(disputed.itemRegistry[0].status, "open");
  assert.equal(disputed.agreementState, "open");
  assert.equal(disputed.canStop, false);
});

test("unanimous merge supersedes only into an existing open target", () => {
  const registry = [
    item("item-001", "external_validation", "Canonical check", "human_operator", "run_external_check"),
    item("item-002", "external_validation", "Duplicate check", "human_operator", "run_external_check"),
  ];
  const merge = [{ action: "merge_into", itemId: "item-002", targetItemId: "item-001" }];
  const result = assessRound([
    control({ goalStatus: "blocked", itemProposals: merge }),
    control({ goalStatus: "blocked", itemProposals: merge }),
  ], 2, registry);
  assert.equal(result.itemRegistry[1].status, "superseded");
  assert.equal(result.itemRegistry[1].mergedIntoId, "item-001");
  assert.equal(result.canStop, true);

  const cycle = [
    { action: "merge_into", itemId: "item-001", targetItemId: "item-002" },
    { action: "merge_into", itemId: "item-002", targetItemId: "item-001" },
  ];
  const invalid = assessRound([
    control({ goalStatus: "blocked", itemProposals: cycle }),
    control({ goalStatus: "blocked", itemProposals: cycle }),
  ], 2, registry);
  assert.equal(invalid.canStop, false);
  assert.equal(invalid.stopReason, "invalid_control");
});

test("exact topic classification conflicts remain visible and prevent a false terminal result", () => {
  const result = assessRound([
    control({ goalStatus: "needs_user", itemProposals: [create("user_decision", "Choose route.", "user", "provide_decision")] }),
    control({ goalStatus: "blocked", itemProposals: [create("external_validation", "choose route", "human_operator", "run_external_check")] }),
  ], 2);
  assert.equal(result.itemRegistry.length, 2);
  assert.equal(result.conflicts[0].code, "classification_conflict");
  assert.equal(result.agreementState, "open");
  assert.equal(result.canStop, false);
});

test("assessment works for every participant count accepted by the protocol", () => {
  const proposal = create("user_decision", "Choose the final mode", "user", "provide_decision");
  const result = assessRound(Array.from({ length: 3 }, () => control({ goalStatus: "needs_user", itemProposals: [proposal] })), 2);
  assert.equal(result.allPresent, true);
  assert.equal(result.itemRegistry.length, 1);
  assert.equal(result.canStop, true);
});
