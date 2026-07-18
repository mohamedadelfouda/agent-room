# Cursor reviewer — live security assessment & the one decision to make

> The reviewer adapter (`server/adapters/cursor.js`, PR #43) is built and **proven live** but deliberately
> **not** registry-wired. This records the live investigation (real `cursor-agent`, Windows x64, 2026-07-18)
> and the single security-policy decision the owner must make before Cursor is enabled as a reviewer. I did
> **not** make that call autonomously — it changes the security model and turns on an external agent.

## Proven live
- **Reviewer works.** Through the trusted launch chain, cursor-agent found a planted `a - b` vs `a + b` bug.
- **No Git-visible writes.** `--mode plan` left `git status` clean even when explicitly prompted to write. (A clean `git status` is not proof of *zero* writes — untracked-ignored and hidden files are not reported; full write-containment needs the name-and-hash snapshot the integration plan specifies, not `git status` alone.)
- **Output shape.** One JSON object: `{ type, subtype, is_error, result, session_id, usage:{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }` — usage tokens are available for the benchmark.
- **Prompt over stdin** (no CLI length limit).
- **Auth is OS-level.** An **empty** isolated `CURSOR_CONFIG_DIR` still authenticates → isolating user config is free: a clean config dir gives no user MCPs/settings while the login persists.

## The hard constraint: Windows has no OS sandbox
cursor-agent **fails closed** on `--sandbox enabled` on Windows (`"Sandbox requires macOS or Linux"`, exit 1); Windows offers only allowlist mode. Consequences:
- **Executor** cannot qualify on Windows (no OS containment for writes/network) → macOS/Linux only. This is the fail-closed outcome already agreed.
- **Reviewer** gets no OS-level network/process isolation on Windows — containment must come from the other layers below.

## What actually protects a Windows review
1. `--mode plan` → read-only (verified: no writes).
2. **Disposable clone as `cwd`** (`server/exec-orchestrator.js`) with no `--add-dir` → the agent's *default* directory is the reviewed code. This is a working directory, **not filesystem confinement**: with no OS sandbox (Windows), the process can still read absolute paths (the user's home, other accessible files). Read-isolation on Windows rests on `--mode plan` + config isolation, not on `cwd`.
3. **Isolated `CURSOR_CONFIG_DIR`** → no user MCPs/settings leak in; login persists (OS-level).
4. No `--approve-mcps`, never `--force`/`--yolo`.
5. Reviewed-tree SHA is re-checked after review (existing behavior) → any **Git-visible** mutation is rejected. Bound: `stageAcceptedTree` stages via `git add -A` + `git ls-files --others --exclude-standard` (`server/worktree.js`), so a *gitignored* file Cursor wrote is not covered by this SHA — the plan-mode read-only property (1) covers those, not the tree hash.

## Unresolved (needs more than tonight)
- **Project MCP injection — inconclusive.** A malicious `.cursor/mcp.json` / `.cursor/cli.json` in the reviewed code did **not** run in any tested configuration (with/without `--trust`, even with `--approve-mcps`). **But** the control — a *user-level* MCP that should run — also didn't fire the marker, because cursor-agent appears to lazy-spawn stdio MCP servers only when a real tool is invoked, and the throwaway server exposed none. So the evidence is "did not run," not proven "cannot run." **Closing this needs a real minimal MCP server** (speaks the protocol, exposes one marker-writing tool) that the agent is asked to call.
- **Network — the model's `networkDenied` layer is miscategorized for a cloud agent.** cursor-agent is a **cloud** agent: it *must* reach its model API, so a literal "network denied" is incoherent (the layer in `server/providers/cursor-qualification.js` was written as if for a local agent). On Windows there is no sandbox to restrict egress. The *practical* exfil surface, however, is bounded by layer 2: the agent can only access the disposable clone's contents — which are **already** sent to Cursor's cloud by design. So the residual is "a malicious project could exfil the code already under review," not "reach the user's other files/secrets."

## The decision (owner)
Enable Cursor as an **experimental reviewer on Windows** given the containment above (read-only + clone-limited + config-isolated; network open; project-MCP-injection observed-absent but not proven-impossible)?

- **A — Enable experimental Windows reviewer.** Label it "Cursor (experimental)", ship the isolated `CURSOR_CONFIG_DIR`, and reconceive the qualification model's `networkDenied` into a cloud-aware `cloudEgressContained` layer (satisfied by clone + config isolation). Real MCP-isolation test as a fast-follow.
- **B — Require the OS sandbox even for review.** Cursor reviewer only on macOS/Linux; Windows waits. Strict, but Cursor is unusable on this machine.

## If A: the implementation is ready to build (on your ratification)
1. Real MCP-isolation test (minimal protocol server) to close the project-MCP question.
2. Adapter: isolated `CURSOR_CONFIG_DIR` per run (mechanism is a small env change; auth persists).
3. Reconceive qualification for cloud reviewers: replace `networkDenied` with egress-containment layers; keep the **executor** requiring a real OS sandbox (unchanged).
4. Registry entry (`capabilities:{ web:false, projectRead:true, projectTransport:"sandbox", connectors:false, executeModes:[] }`, gated on `reviewQualified`) + a Cursor-specific readiness path (the existing readiness assumes a single named binary + `<cmd> --version` via the shim, which the process allowlist rejects).

Everything up to this decision is shipped in PRs #41–#43; this doc is the gate.
