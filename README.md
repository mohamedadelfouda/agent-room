# Agent Room

Agent Room is a local desktop workspace where multiple coding-agent CLIs share evidence, challenge one proposal, and leave the final decision to the user. It currently ships provider adapters for Claude Code and Codex CLI.

The product is built around four contracts:

- Both agents receive the same bounded evidence pack from a trusted project.
- Early stopping requires agreement on the latest proposal version **and** a satisfied user goal.
- One executor changes a disposable local Git clone; a separate agent reviews the captured tree read-only.
- The accepted project commit, merge, pull request, email, issue, or database write happens only after an explicit user decision. Disposable executor commits, if any, are collapsed before acceptance.

## What is different

Agent Room is not a side-by-side chat wrapper. It records proposal versions and machine-readable goal status, shows why rounds stopped, preserves unresolved points, and keeps a decision log. Its Execute → Review → Decide path creates the accepted Git commit only after approval and rechecks the immutable Git tree for secrets immediately before that commit.

Optional connector tools use the same rule. Read actions require per-session opt-in. State-changing GitHub, Gmail, and Supabase tools create a pending proposal; they do not perform the action until the user approves it in Agent Room. Installed desktop builds can configure Gmail and Supabase through OS-backed encrypted storage; source deployments can use documented environment variables.

## Install the desktop app

Tagged releases build native artifacts on all three platforms:

- Windows: `Agent Room-<version> Setup.exe` (Squirrel installer)
- macOS: `.zip` (unzip and move Agent Room to Applications)
- Linux: `.deb` and `.rpm`

Download them from [GitHub Releases](https://github.com/mohamedadelfouda/agent-room/releases). Public builds need the maintainer's signing credentials to avoid Windows SmartScreen and macOS Gatekeeper warnings; see [desktop distribution](docs/DESKTOP.md).

The installed app is one click: it starts its private loopback server on a free port, opens one secured Electron window, and stores sessions/logs under the operating system's application-data directory.

## Required agent CLIs

Agent Room uses your existing CLI subscriptions; it does not proxy them through an Agent Room cloud backend.

- Claude Code, installed and signed in
- Codex CLI, installed and signed in
- Git, with a user name and email configured for projects you want to execute against
- GitHub CLI (`gh`), signed in only for GitHub browsing, issues, or pull requests

Windows command discovery accepts native `.exe`/`.com` binaries. Arbitrary `.cmd`, `.bat`, and PowerShell shims are not executed through a shell.

If a provider check fails, the in-app **Set up** button runs a read-only search for the native executable that npm/pnpm shim installs hide (for example, a global Codex install on Windows) and offers per-provider install commands to copy. A discovered path is used only after you approve it through **Trust & check**; Agent Room never runs installers itself.

Prompts and project excerpts are sent to the selected model providers through their official CLIs. Session JSON is stored locally and can contain the user's text and agent output.

## Run from source

Node.js 22 or newer is required.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm desktop
```

For the browser-only local server:

```bash
pnpm start
```

Source checkouts also include `start-windows.bat`, `start-macos.command`, and `start-linux.sh`. These launch the browser-only server and require Node.js 22+.

## Validate

```bash
pnpm check
pnpm test
pnpm make
```

`pnpm make` creates artifacts only for the current operating system. The GitHub workflow [desktop-build.yml](.github/workflows/desktop-build.yml) builds Windows, macOS, and Linux artifacts on their native runners.

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
