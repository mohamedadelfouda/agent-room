// Cancellation state machine for one execute+review run: exactly one executor writes in a
// disposable clone, then one reviewer reads the captured diff. This mirrors run-state.js for the
// execution pipeline and is kept as pure functions so the stop/cancel race can be unit-tested
// without spawning git or provider child processes.

const TERMINAL_STATUSES = new Set(["stopped", "finished"]);

// The single cancellation-sentinel message, thrown at each pipeline-stage gate and surfaced as the
// terminal exec_error. Centralized so the executor, the worktree builder, and the orchestrator
// (plus the test that pins it) can't drift apart. Mirrors run-state.js owning runInactiveError().
export const EXEC_STOPPED_MESSAGE = "Execution stopped by user";

export function createExecAttempt() {
  return {
    // running → cancelling (a Stop was accepted) → stopped | finished (terminal, claimed once).
    status: "running",
    children: new Set(),
  };
}

// True once a Stop has been accepted, or the run already settled as stopped. Threaded into the
// executor pipeline as isCancelled() so each stage can bail before it starts the next child.
export function execWasCancelled(attempt) {
  return attempt.status === "cancelling" || attempt.status === "stopped";
}

// Record a Stop request. Returns false when the run cannot accept one (already cancelling, or
// already terminal) so stopExec can report "already stopping" instead of re-running terminate +
// settle a second time.
export function requestExecCancellation(attempt) {
  if (attempt.status !== "running") return false;
  attempt.status = "cancelling";
  return true;
}

// Track a freshly spawned child. Returns true when tracked (run still live). Returns false when a
// Stop already landed — the child must never run, so the caller kills it immediately. runProcess
// calls this synchronously right after spawn (no await between spawn and this call) and stopExec
// runs on the same single thread, so the cancel check here is atomic with the spawn: a Stop that
// lands first makes this return false (the caller kills the child now); a spawn that wins puts the
// child in `children` for stopExec's terminate loop to kill. No child can slip past an accepted Stop.
export function trackExecChild(attempt, child, onClose) {
  if (execWasCancelled(attempt)) return false;
  attempt.children.add(child);
  child.once("close", () => {
    attempt.children.delete(child);
    onClose?.(child);
  });
  return true;
}

// Claim the single terminal transition. The run body's finally claims "finished"; a Stop that has
// to force-finalize a wedged run claims "stopped". Idempotent — the first caller wins, so a stalled
// stop's finalize and the body's own finally never both emit the terminal event or release the
// activity claim.
export function claimExecTerminal(attempt, status) {
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Invalid terminal execution status: ${status}`);
  if (TERMINAL_STATUSES.has(attempt.status)) return false;
  attempt.status = status;
  return true;
}
