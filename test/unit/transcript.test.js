import test from "node:test";
import assert from "node:assert/strict";
import { transcriptFor } from "../../server/prompts.js";

const session = (messages) => ({ messages });

test("transcriptFor renders speakers and content", () => {
  const out = transcriptFor(session([
    { author: "user", content: "hello there", phase: "user" },
    { author: "agent", agent: "claude", role: "Collaborator", content: "hi back", phase: "collaboration", round: 1 },
  ]));
  assert.match(out, /USER/);
  assert.match(out, /hello there/);
  assert.match(out, /CLAUDE/);
  assert.match(out, /hi back/);
});

test("transcriptFor trims to maxChars and flags it", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ author: "user", content: "x".repeat(1000) + `#${i}#` }));
  const out = transcriptFor(session(many), 5000);
  // Trimmed output is the tail plus a short prefix marker.
  assert.ok(out.length <= 5000 + 120, `unexpected length ${out.length}`);
  assert.match(out, /trimmed/i);
  // The most recent message must survive; the oldest must be gone.
  assert.match(out, /#59#/);
  assert.doesNotMatch(out, /#0#/);
});

test("transcriptFor handles empty / missing messages", () => {
  assert.equal(transcriptFor(session([])), "");
  assert.equal(transcriptFor({}), "");
});
