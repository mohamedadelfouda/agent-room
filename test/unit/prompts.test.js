import { test } from "node:test";
import assert from "node:assert/strict";
import { collaborationPrompt, debatePrompt } from "../../server/prompts.js";

const session = { messages: [] };
const base = { session, agentLabel: "Claude", role: "Collaborator", totalRounds: 5, userTask: "design X" };

test("collaboration round 1 asks for the full proposal", () => {
  const p = collaborationPrompt({ ...base, round: 1 });
  assert.match(p, /Updated shared proposal/);
  assert.doesNotMatch(p, /do NOT restate the whole plan/);
});

test("collaboration round 2+ is delta-only, not a full rewrite", () => {
  const p = collaborationPrompt({ ...base, round: 2 });
  assert.match(p, /do NOT restate the whole plan/);
  assert.match(p, /New delta/);
  assert.doesNotMatch(p, /Updated shared proposal/);
});

test("collaboration keeps the CONVERGENCE control line in every round", () => {
  for (const round of [1, 3]) {
    assert.match(collaborationPrompt({ ...base, round }), /CONVERGENCE: converged/);
  }
});

test("debate opening round asks for the full 7-part position", () => {
  const p = debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true });
  assert.match(p, /Recommended decision/);
  assert.doesNotMatch(p, /do NOT restate your whole position/);
});

test("debate rebuttal round is delta-only", () => {
  const p = debatePrompt({ ...base, opponentLabel: "Codex", round: 2, independent: false });
  assert.match(p, /do NOT restate your whole position/);
  assert.match(p, /New delta/);
  assert.doesNotMatch(p, /Recommended decision/);
});
