# Architecture

## Runtime

`desktop/main.js` is the Electron main process. It starts `server/index.js` on an ephemeral loopback port, then loads that URL in a sandboxed `BrowserWindow` with Node integration disabled. Source mode can run the same server directly on port `3210` unless `PORT` is set.

`server/index.js` owns HTTP routing, same-origin authorization, server-sent events, lifecycle shutdown, background startup reconciliation, and static files from `public/`. The server starts accepting UI connections before reconciliation completes, while new execution requests remain gated until recovery finishes. `server/store.js` serializes read-modify-write transitions per session, replaces JSON files atomically, and creates the runtime scratch workspace on demand. It keeps up to 200 messages and decisions, 50 terminal executions, and 100 terminal connector actions while preserving actionable records. Nested metadata and the total session footprint are bounded. Compact summary sidecars make the session list independent of transcript size. Desktop data uses `AGENT_ROOM_RUNTIME_DIR`; source mode uses the repository's ignored `data/`, `logs/`, and `workspace/` folders.

## Collaboration pipeline

`server/orchestrator.js` selects providers from `server/providers/registry.js`. A trusted project produces one bounded shared evidence pack through `server/project.js`. Round one establishes proposals. Later rounds run from the same session snapshot and end in a validated `<agent-control>` JSON block.

`server/convergence.js` validates the version 2 control contract. Agents propose item changes through `itemProposals`; deterministic assessment applies valid proposals to the official `itemRegistry` and derives `nextSteps` from its open items. Agents cannot close or merge an official item by omission, and closing or merging an existing item requires the same explicit action from every participant. Stored unversioned controls with `openPoints` remain readable, but their unclassified points cannot create an early stop.

Agreement and completion are assessed separately. Early stop requires every participating provider to supply a valid current control, report no substantive delta, and report convergence without a genuine disagreement. The terminal completion state may be `satisfied`, `needs_user`, or `blocked`; `incomplete`, missing, invalid, stale, or contradictory control data keeps the discussion open. The orchestrator stores the approved outcome with the system message before asking the finalizer to explain it, so finalizer prose cannot change the official result.

`public/app.js` renders one round-summary card for the latest user run. New sessions read the persisted outcome directly and show localized agreement, completion, stop reason, pending categories, and derived next steps. Legacy sessions fall back to their stored report and `openPoints` without rewriting session files.

## Execution pipeline

`server/executor.js`, `server/exec-orchestrator.js`, `server/acceptance.js`, and `server/worktree.js` implement the lifecycle documented in [EXECUTION.md](../EXECUTION.md). Each writer receives a disposable independent clone whose Git objects and refs stay outside the project repository. The reviewed tree is imported only after acceptance under an exact private ref. Raw child processes are centralized in `server/process.js`, which preserves argument boundaries with `shell: false`, bounds output, sanitizes agent environments, applies timeouts, and contains descendant processes with Windows Job Objects or POSIX process groups.

## Connector pipeline

`server/connectors/registry.js` defines connector actions and whether they change external state. `server/connectors/service.js` enforces per-session opt-in and atomically claims each approval before its side effect. `server/connector-config.js` serializes host credential updates; the desktop main process persists them with Electron `safeStorage`. `server/mcp-server.js` is a credential-free stdio proxy. It forwards bounded requests through an authenticated, per-run loopback grant to the host process, where sessions and connector credentials remain available.

Claude receives a strict per-run MCP configuration containing only Agent Room's broker. Project-read, web, and connector calls are separated so a single model call cannot combine local files with external tools. Codex does not receive automatic connector injection because its current CLI configuration has no equivalent strict per-run MCP-only flag; Codex project calls also disable web. This avoids silently loading unrelated MCP servers.

## Extension boundaries

- Provider-specific CLI flags and output parsing stay in `server/adapters/`.
- Provider catalog metadata and supported modes stay in `server/providers/registry.js`.
- Connector schemas and external calls stay in `server/connectors/`; encrypted persistence stays in the Electron main process.
- Approval, retry, and session persistence stay outside adapters and connectors.
- Browser code consumes public catalogs; it does not contain the source of truth for providers or actions.
