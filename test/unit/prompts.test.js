import { test } from "node:test";
import assert from "node:assert/strict";
import { collaborationPrompt, debatePrompt } from "../../server/prompts.js";

const session = { messages: [] };
const base = { session, agentLabel: "Claude", role: "Collaborator", totalRounds: 5, userTask: "design X" };

test("collaboration round 1 asks for the full take", () => {
  const p = collaborationPrompt({ ...base, round: 1 });
  assert.match(p, /Lay out your take in full/);
  assert.doesNotMatch(p, /keep it to what's actually new/);
});

test("collaboration round 2+ is delta-only, not a full rewrite", () => {
  const p = collaborationPrompt({ ...base, round: 2 });
  assert.match(p, /keep it to what's actually new/);
  assert.match(p, /don't rewrite the whole plan/);
  assert.doesNotMatch(p, /Lay out your take in full/);
});

test("collaboration emits the CONVERGENCE control line only from round 2 on", () => {
  // Round 1: nobody has seen a full exchange yet — no convergence verdict is asked for.
  assert.doesNotMatch(collaborationPrompt({ ...base, round: 1 }), /CONVERGENCE: converged/);
  assert.match(collaborationPrompt({ ...base, round: 3 }), /CONVERGENCE: converged/);
});

test("collaboration asks for file/line evidence only when a project is attached", () => {
  assert.doesNotMatch(collaborationPrompt({ ...base, round: 1 }), /point to the file/);
  assert.match(collaborationPrompt({ ...base, round: 1, projectSnapshot: "TREE" }), /point to the file/);
});

test("debate opening round asks for a full position and no convergence verdict", () => {
  const p = debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true });
  assert.match(p, /This is your opening/);
  assert.doesNotMatch(p, /go straight at the strongest opposing point/);
  // An independent opening can't judge convergence against an opponent it hasn't seen.
  assert.doesNotMatch(p, /CONVERGENCE: converged/);
});

test("debate rebuttal round is delta-only and does emit the convergence line", () => {
  const p = debatePrompt({ ...base, opponentLabel: "Codex", round: 2, independent: false });
  assert.match(p, /go straight at the strongest opposing point/);
  assert.doesNotMatch(p, /This is your opening/);
  assert.match(p, /CONVERGENCE: converged/);
});
