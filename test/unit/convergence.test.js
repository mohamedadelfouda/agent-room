import test from "node:test";
import assert from "node:assert/strict";
import { parseConvergence, stripConvergence, assessRound } from "../../server/convergence.js";

test("parseConvergence reads converged (case-insensitive)", () => {
  assert.deepEqual(parseConvergence("blah\nCONVERGENCE: converged"), { converged: true, open: "" });
  assert.equal(parseConvergence("CONVERGENCE: CONVERGED").converged, true);
});

test("parseConvergence reads open with points", () => {
  const r = parseConvergence("text\nCONVERGENCE: open — pricing and rollout");
  assert.equal(r.converged, false);
  assert.equal(r.open, "pricing and rollout");
});

test("parseConvergence treats a missing marker as open", () => {
  assert.deepEqual(parseConvergence("just some text"), { converged: false, open: "" });
});

test("parseConvergence tolerates markdown / leading chars", () => {
  assert.equal(parseConvergence("**CONVERGENCE: converged**").converged, true);
  assert.equal(parseConvergence("> CONVERGENCE: open — X").open, "X");
});

test("stripConvergence removes the marker line from the shown message", () => {
  const out = stripConvergence("my answer\n\nCONVERGENCE: converged");
  assert.equal(out.includes("CONVERGENCE"), false);
  assert.equal(out, "my answer");
});

test("assessRound: both converged -> stop early, no disagreements", () => {
  const r = assessRound([{ converged: true, open: "" }, { converged: true, open: "" }]);
  assert.equal(r.bothConverged, true);
  assert.deepEqual(r.disagreements, []);
});

test("assessRound: one open -> not converged, collects the open point", () => {
  const r = assessRound([{ converged: true, open: "" }, { converged: false, open: "budget" }]);
  assert.equal(r.bothConverged, false);
  assert.deepEqual(r.disagreements, ["budget"]);
});

test("assessRound: dedups disagreements and ignores empties / empty input", () => {
  assert.deepEqual(assessRound([{ converged: false, open: "scope" }, { converged: false, open: "scope" }]).disagreements, ["scope"]);
  assert.equal(assessRound([]).bothConverged, false);
});
