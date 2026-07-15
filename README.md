# Agent Room

Agent Room is a local workspace where multiple coding-agent CLIs share evidence, challenge one proposal, and leave the final decision to the user. It currently ships provider adapters for Claude Code and Codex CLI.

The product is built around four contracts:

- Both agents receive the same bounded evidence pack from a trusted project.
- Early stopping requires a valid, delta-free agreement on the latest proposal version. A settled run may finish as complete, waiting for the user, or waiting for external validation; incomplete work and genuine disagreement keep the discussion open.
- One executor changes a disposable local Git clone; a separate agent reviews the captured tree read-only.
- The accepted project commit, merge, pull request, email, issue, or database write happens only after an explicit user decision. Disposable executor commits, if any, are collapsed before acceptance.

## What is different

Agent Room is not a side-by-side chat wrapper. It records proposal versions, a machine-approved pending-item registry, and separate agreement and task-completion states. The decision card shows why the latest run stopped and the next required step without treating a user choice or external check as agent disagreement. Its Execute → Review → Decide path creates the accepted Git commit only after approval and rechecks the immutable Git tree for secrets immediately before that commit.

Optional connector tools use the same rule. Read actions require per-session opt-in. State-changing GitHub, Gmail, and Supabase tools create a pending proposal; they do not perform the action until the user approves it in Agent Room. Connector credentials for source deployments use documented environment variables; optional Electron builds can use OS-backed encrypted storage when you package them locally.

## Run the local server

Node.js 22 or newer is required. Agent Room is meant to run as a **loopback HTTP server** and open in your browser.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

By default the server listens on **`http://127.0.0.1:3210`**. Override the port with `PORT` when needed:

```bash
PORT=3210 pnpm start
```

On Windows you can also double-click `start-windows.bat` (macOS: `start-macos.command`, Linux: `start-linux.sh`). Those scripts start the same browser-facing server.

There are no published GitHub Release installers right now. To try the optional Electron shell from this checkout: `pnpm desktop` (see [desktop distribution](docs/DESKTOP.md) if you build locally).

## Required agent CLIs

Agent Room uses your existing CLI subscriptions; it does not proxy them through an Agent Room cloud backend.

- Claude Code, installed and signed in
- Codex CLI, installed and signed in
- Git, with a user name and email configured for projects you want to execute against
- GitHub CLI (`gh`), signed in only for GitHub browsing, issues, or pull requests

Windows command discovery accepts native `.exe`/`.com` binaries. Arbitrary `.cmd`, `.bat`, and PowerShell shims are not executed through a shell.

If a provider check fails, the in-app **Set up** button runs a read-only search for the native executable that npm/pnpm shim installs hide (for example, a global Codex install on Windows) and offers per-provider install commands to copy. A discovered path is used only after you approve it through **Trust & check**; Agent Room never runs installers itself.

Prompts and project excerpts are sent to the selected model providers through their official CLIs. Session JSON is stored locally and can contain the user's text and agent output.

## Validate

```bash
pnpm check
pnpm test
```

## Safety boundaries

- Project files are unavailable to agents until the user explicitly trusts the project fingerprint.
- Planning and review are read-only. Agent process environments use an allowlist and do not inherit arbitrary token/key variables.
- Output, line size, final-response files, and each agent call are bounded.
- Execution is offered only by providers that can enforce the requested local boundary. The current registry exposes one `run` mode for Codex because its workspace sandbox permits both edits and local commands; it does not advertise a prompt-only edit mode. Claude is collaboration/review-only until its CLI can enforce an equivalent write boundary.
- There is no executor `full` or pre-approved publish mode. Pull requests are created only from the acceptance endpoint.
- Connector credentials remain in the host and are excluded from agent, GitHub, and publication subprocess environments and prompts.
- Claude project reads use Agent Room's bounded host broker; Claude cannot combine project files with web or connector tools in the same call. Codex project calls run without web or connectors.
- Stored sessions retain up to 200 messages and decisions, 50 terminal executions, and 100 terminal connector actions while preserving pending records. Nested metadata and total session size are bounded.
- Each execution uses a disposable clone with its own Git objects, refs, and configuration, so rejected or secret-bearing objects never enter the project repository. The clone is still not a general operating-system sandbox or a limit on every possible filesystem read. See [SECURITY.md](SECURITY.md) for the threat model and reporting instructions.

## Extend Agent Room

- [Product principles](PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Add a provider or model](docs/PROVIDERS.md)
- [Connector and MCP approval contract](docs/CONNECTORS.md)
- [Execute → Review → Decide](EXECUTION.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

## License

MIT © Mohamed Adel Fouda
