const CONTROL_BLOCK = /<agent-control>([\s\S]*?)<\/agent-control>/gi;
const CONVERGENCE = new Set(["converged", "open", "not_evaluated"]);
const GOAL_STATUS = new Set(["satisfied", "incomplete", "blocked", "needs_user"]);

function invalidControl() {
  return {
    valid: false,
    convergence: "unknown",
    converged: false,
    goalStatus: "incomplete",
    substantiveDelta: false,
    openPoints: [],
    open: "",
    confidence: 0,
    targetVersion: null,
  };
}

function validatedControl(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (!CONVERGENCE.has(candidate.convergence) || !GOAL_STATUS.has(candidate.goalStatus)) return null;
  if (typeof candidate.substantiveDelta !== "boolean") return null;
  if (!Array.isArray(candidate.openPoints) || candidate.openPoints.length > 20) return null;
  if (!candidate.openPoints.every((point) => typeof point === "string" && point.length <= 500)) return null;
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return null;
  if (!Number.isInteger(candidate.targetVersion) || candidate.targetVersion < 1) return null;
  const openPoints = candidate.openPoints.map((point) => point.trim()).filter(Boolean);
  return {
    valid: true,
    convergence: candidate.convergence,
    converged: candidate.convergence === "converged",
    goalStatus: candidate.goalStatus,
    substantiveDelta: candidate.substantiveDelta,
    openPoints,
    open: openPoints.join("; "),
    confidence: candidate.confidence,
    targetVersion: candidate.targetVersion,
  };
}

export function parseAgentControl(text) {
  const source = String(text || "");
  const matches = [...source.matchAll(CONTROL_BLOCK)];
  const match = matches.at(-1);
  if (!match || source.slice((match.index || 0) + match[0].length).trim()) return invalidControl();
  try { return validatedControl(JSON.parse(match[1])) || invalidControl(); }
  catch { return invalidControl(); }
}

export function stripAgentControl(text) {
  return String(text || "").replace(CONTROL_BLOCK, "").trimEnd();
}

export function assessRound(controls, targetVersion) {
  const present = controls.filter(Boolean);
  const allPresent = present.length === controls.length && present.length >= 2;
  const allValid = allPresent && present.every((control) => control.valid);
  const versionAligned = allValid && present.every((control) => control.targetVersion === targetVersion);
  const proposalChanged = versionAligned && present.some((control) => control.substantiveDelta);
  const goalSatisfied = allValid && present.every((control) => control.goalStatus === "satisfied");
  const consensus = allValid && present.every((control) => control.convergence === "converged");
  const disagreements = [...new Set(present.flatMap((control) => control.openPoints || []).filter(Boolean))];
  const canStop = versionAligned && !proposalChanged && goalSatisfied && consensus && disagreements.length === 0;
  return { canStop, bothConverged: canStop, disagreements, proposalChanged, goalSatisfied, versionAligned };
}
