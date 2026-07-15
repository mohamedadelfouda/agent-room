import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentControl, stripAgentControl, assessRound } from "../../server/convergence.js";

function block(overrides = {}) {
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

test("parseAgentControl accepts one valid final control block", () => {
  const control = parseAgentControl(`reader-facing answer\n${block()}`);
  assert.equal(control.valid, true);
  assert.equal(control.converged, true);
  assert.equal(control.goalStatus, "satisfied");
  assert.equal(control.targetVersion, 2);
});

test("missing, malformed, embedded, and schema-invalid control fail closed", () => {
  for (const text of [
    "reader-facing answer only",
    "<agent-control>{not json}</agent-control>",
    `${block()}\nextra text`,
    block({ confidence: 2 }),
    block({ targetVersion: 0 }),
    block({ openPoints: "scope" }),
  ]) {
    const control = parseAgentControl(text);
    assert.equal(control.valid, false);
    assert.equal(control.converged, false);
    assert.equal(control.goalStatus, "incomplete");
  }
});

test("the final control block is authoritative and all blocks are stripped", () => {
  const text = `answer\n${block({ convergence: "open", goalStatus: "incomplete", openPoints: ["scope"] })}\ncorrection\n${block()}`;
  assert.equal(parseAgentControl(text).convergence, "converged");
  assert.equal(stripAgentControl(text), "answer\n\ncorrection");
});

test("assessRound stops only on aligned, complete, unchanged consensus", () => {
  const controls = [parseAgentControl(block()), parseAgentControl(block())];
  const result = assessRound(controls, 2);
  assert.equal(result.canStop, true);
  assert.equal(result.bothConverged, true);
  assert.deepEqual(result.disagreements, []);
});

test("assessRound does not stop while converged controls report open points", () => {
  const control = parseAgentControl(block({ openPoints: ["still unresolved"] }));
  const result = assessRound([control, control], 2);
  assert.equal(result.canStop, false);
  assert.deepEqual(result.disagreements, ["still unresolved"]);
});

test("assessRound never stops with missing, invalid, stale, incomplete, or changing input", () => {
  const valid = parseAgentControl(block());
  const cases = [
    [valid],
    [valid, null],
    [valid, parseAgentControl("bad")],
    [valid, parseAgentControl(block({ targetVersion: 1 }))],
    [valid, parseAgentControl(block({ goalStatus: "incomplete" }))],
    [valid, parseAgentControl(block({ substantiveDelta: true }))],
    [valid, parseAgentControl(block({ convergence: "open", openPoints: ["budget"] }))],
  ];
  for (const controls of cases) assert.equal(assessRound(controls, 2).canStop, false);
});

test("a stale control cannot advance the current proposal version", () => {
  const current = parseAgentControl(block({ targetVersion: 4, substantiveDelta: false }));
  const stale = parseAgentControl(block({ targetVersion: 3, substantiveDelta: true }));
  const assessment = assessRound([current, stale], 4);
  assert.equal(assessment.versionAligned, false);
  assert.equal(assessment.proposalChanged, false);
  assert.equal(assessment.canStop, false);
});

test("assessRound deduplicates open points and identifies proposal changes", () => {
  const result = assessRound([
    parseAgentControl(block({ convergence: "open", goalStatus: "incomplete", openPoints: ["scope"], substantiveDelta: true })),
    parseAgentControl(block({ convergence: "open", goalStatus: "incomplete", openPoints: ["scope", "budget"] })),
  ], 2);
  assert.deepEqual(result.disagreements, ["scope", "budget"]);
  assert.equal(result.proposalChanged, true);
  assert.equal(result.canStop, false);
});
