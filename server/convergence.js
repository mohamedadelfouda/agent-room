// Agents end each collaboration/debate turn with a CONVERGENCE marker so the orchestrator
// can stop early once they agree, or report the open disagreements when they don't — with
// zero extra model calls. Parsing is tolerant: a missing or malformed marker counts as
// "still open", so a forgetful agent never falsely ends the discussion.

const MARKER = /^[ \t>*_-]*CONVERGENCE:\s*(converged|open)\b(.*)$/im;

// -> { converged: boolean, open: string }
export function parseConvergence(text) {
  const m = String(text || "").match(MARKER);
  if (!m) return { converged: false, open: "" };
  if (/converged/i.test(m[1])) return { converged: true, open: "" };
  return { converged: false, open: (m[2] || "").replace(/^[\s—:–-]+/, "").trim() };
}

// Remove the marker line from a message before it's shown to the user.
export function stripConvergence(text) {
  return String(text || "").replace(MARKER, "").replace(/[ \t]*\n{2,}$/, "\n").trimEnd();
}

// Decide a round from every agent's parsed convergence. Both must converge to stop early.
export function assessRound(convergences) {
  const list = convergences.filter(Boolean);
  const bothConverged = list.length > 0 && list.every((c) => c.converged);
  const disagreements = [...new Set(list.filter((c) => !c.converged && c.open).map((c) => c.open))];
  return { bothConverged, disagreements };
}
