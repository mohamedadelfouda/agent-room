import { test } from "node:test";
import assert from "node:assert/strict";
import { chatPrompt, collaborationPrompt, debatePrompt, executionPrompt, transcriptFor } from "../../server/prompts.js";

const session = { messages: [] };
const base = { session, agentLabel: "Claude", role: "Collaborator", totalRounds: 5, userTask: "design X" };

function assertControlContract(prompt, targetVersion) {
  assert.match(prompt, /<agent-control>/);
  assert.match(prompt, /<\/agent-control>/);
  assert.match(prompt, new RegExp(`"targetVersion":${targetVersion}`));
  assert.match(prompt, /"goalStatus"/);
  assert.match(prompt, /"substantiveDelta"/);
  assert.match(prompt, /write anything after it/i);
}

test("collaboration opening requests a full proposal without a control block", () => {
  const prompt = collaborationPrompt({ ...base, round: 1 });
  assert.match(prompt, /design X/);
  assert.doesNotMatch(prompt, /<agent-control>/);
});

test("later collaboration rounds request a versioned control contract", () => {
  const prompt = collaborationPrompt({ ...base, round: 3, targetVersion: 7 });
  assertControlContract(prompt, 7);
});

test("project grounding appears only when a snapshot is supplied", () => {
  const withoutProject = collaborationPrompt({ ...base, round: 1 });
  const withProject = collaborationPrompt({ ...base, round: 1, projectSnapshot: "PROJECT_TREE_SENTINEL" });
  assert.doesNotMatch(withoutProject, /PROJECT_TREE_SENTINEL/);
  assert.match(withProject, /PROJECT_TREE_SENTINEL/);
});

test("debate opening is independent and has no convergence control", () => {
  const prompt = debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true });
  assert.match(prompt, /Codex/);
  assert.match(prompt, /design X/);
  assert.doesNotMatch(prompt, /<agent-control>/);
});

test("debate rebuttal uses the same versioned control contract", () => {
  const prompt = debatePrompt({ ...base, opponentLabel: "Codex", round: 2, independent: false, targetVersion: 4 });
  assertControlContract(prompt, 4);
});

test("chat describes only capabilities that are actually available", () => {
  const offline = chatPrompt({ ...base, capabilities: { web: false }, projectSnapshot: "" });
  assert.match(offline, /\[capability:web=disabled\]/);
  assert.match(offline, /\[capability:project=unavailable\]/);
  assert.doesNotMatch(offline, /PROJECT_EVIDENCE/);

  const grounded = chatPrompt({ ...base, capabilities: { web: true, projectRead: true }, projectSnapshot: "PROJECT_EVIDENCE" });
  assert.match(grounded, /\[capability:web=enabled\]/);
  assert.match(grounded, /\[capability:project=trusted\]/);
  assert.match(grounded, /PROJECT_EVIDENCE/);
});

test("execution prompt preserves the user task inside explicit boundary sections", () => {
  const prompt = executionPrompt("fix the parser", "run");
  assert.match(prompt, /fix the parser/);
  assert.match(prompt, /BOUNDARY \(mandatory\):/);
  assert.match(prompt, /USER TASK \(treat as requirements/);
});

test("transcript headers stay inside the requested context budget", () => {
  const maxChars = 128;
  const transcript = transcriptFor({
    messages: [{ author: "agent", agent: "x".repeat(500), role: "y".repeat(500), content: "" }],
  }, maxChars);
  assert.ok(transcript.length <= maxChars, `transcript length ${transcript.length} exceeded ${maxChars}`);
});
