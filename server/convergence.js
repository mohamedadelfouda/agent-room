// Agents end each collaboration/debate turn with a CONVERGENCE marker so the orchestrator
// can stop early once they agree, or report the open disagreements when they don't — with
// zero extra model calls. Parsing is tolerant: a missing or malformed marker counts as
// "still open", so a forgetful agent never falsely ends the discussion.

// The marker is meant to be the FINAL line, but agents sometimes echo the instruction or
// restate it, so we always take the LAST occurrence and strip ALL of them (a fresh global
// regex per call keeps matchAll/replace state-independent).
const marker = () => /^[ \t>*_-]*CONVERGENCE:\s*(converged|open)\b(.*)$/gim;

// -> { converged: boolean, open: string }
export function parseConvergence(text) {
  const matches = [...String(text || "").matchAll(marker())];
  const m = matches[matches.length - 1];
  if (!m) return { converged: false, open: "" };
  if (/converged/i.test(m[1])) return { converged: true, open: "" };
  return { converged: false, open: (m[2] || "").replace(/^[\s—:–-]+/, "").trim() };
}

// Remove every marker line from a message before it's shown / fed to the next round.
export function stripConvergence(text) {
  return String(text || "").replace(marker(), "").trimEnd();
}

// Decide a round from every agent's parsed convergence. Every agent present must have a
// parsed result AND all must be converged to stop early — never stop on a single agent.
export function assessRound(convergences) {
  const list = convergences.filter(Boolean);
  const bothConverged = list.length === convergences.length && list.length >= 2 && list.every((c) => c.converged);
  const disagreements = [...new Set(list.filter((c) => !c.converged && c.open).map((c) => c.open))];
  return { bothConverged, disagreements };
}
