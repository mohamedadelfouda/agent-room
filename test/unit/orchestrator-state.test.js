import test from "node:test";
import assert from "node:assert/strict";
import { mergeOrchestrationState } from "../../server/orchestrator.js";

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
