<div align="right"><a href="README.ar.md">🇪🇬 اقرأ بالعربية</a></div>

# Agent Room

**You already use two AI coding agents. Agent Room makes them work together — and keeps you in charge.**

If you code with Claude and Codex, you know the routine: paste a task into one, paste its answer into the other to "have it reviewed," lose track of who suggested what, and play human glue between two chat windows — always one careless paste away from letting an agent loose on your real repo.

Agent Room puts them in one room instead.

Both agents get the same evidence from your project. One proposes a change and carries it out — but only inside a **throwaway copy** of your repo, never the real one. The other reviews the result. You see the proposal, the review, and a plain "here's why this run stopped and what it needs next" — then **you** decide. Nothing touches your project, no pull request opens, no email sends, until you say yes.

And it isn't two chat windows side by side. Agent Room keeps track of proposal versions, what the agents *actually* agreed on, and whether the work is done or just waiting on you — so a run ends because it's genuinely finished, not because someone ran out of things to say.

The same rule covers connectors: reading GitHub, Gmail, or Supabase is opt-in per session, and anything that *changes* something waits as a proposal until you approve it.

### How one run goes

1. **Trust a project.** Nothing is shared with the agents until you do.
2. **They work from the same evidence.** One executes on a disposable clone; the other reviews the captured result read-only.
3. **You get a decision card** — the proposal, the review, and exactly why it stopped and what's next.
4. **You decide.** Only then does the real Git commit, merge, PR, email, or database write happen — and the tree is re-scanned for secrets right before it lands.

> Try it with one command (once it's on npm): **`npx agent-room`** — it opens in your browser.

## Run the local server

Node.js 22 or newer is required. Agent Room is meant to run as a **loopback HTTP server** and open in your browser.

```bash
corepack enable
pnpm install --prod --frozen-lockfile --ignore-scripts
pnpm start
```

By default the server listens on **`http://127.0.0.1:3210`**. Override the port with `PORT` when needed:

```bash
PORT=3210 pnpm start
```

PowerShell:

```powershell
$env:PORT = "3210"
pnpm start
```

The production-only install verifies the lockfile and skips the desktop development toolchain. The source server uses Node.js built-ins and has no production npm dependencies.

## Required agent CLIs

Agent Room uses your existing CLI subscriptions; it does not proxy them through an Agent Room cloud backend.

- Claude Code, installed and signed in
- Codex CLI, installed and signed in
- Git, with a user name and email configured for projects you want to execute against
- GitHub CLI (`gh`), signed in only for GitHub browsing, issues, or pull requests

Windows command discovery accepts native `.exe`/`.com` binaries. Arbitrary `.cmd`, `.bat`, and PowerShell shims are not executed through a shell.

If a provider is installed only as an npm/pnpm shim (for example, a global Codex install on Windows), Agent Room discovers the bundled native executable at its known package layout, verifies it runs, and trusts it automatically — so it is detected without a manual step. A path *you* supply yourself is used only after you approve it through **Trust & check**, and the in-app **Set up** button also offers per-provider install commands to copy. Agent Room never runs installers itself.

Prompts and project excerpts are sent to the selected model providers through their official CLIs. Session JSON is stored locally and can contain the user's text and agent output.

## Validate

Contributor setup installs the development toolchain without running package lifecycle scripts:

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm lint
pnpm test
pnpm test:coverage
pnpm test:smoke
pnpm test:browser
```

`pnpm lint` downloads the pinned ESLint version into a temporary npm cache; it does not add it to the source-server dependency graph. The browser test uses a system Chrome or Edge executable and accepts an override through `AGENT_ROOM_BROWSER`.

## Safety boundaries

- Project files are unavailable to agents until the user explicitly trusts the project fingerprint.
- A trusted provider executable is stored with a SHA-256 fingerprint. If the executable changes at the approved path, Agent Room requires **Trust & check** again.
- Planning and review are read-only. Agent process environments use an allowlist and do not inherit arbitrary token/key variables.
- Output, line size, final-response files, and each agent call are bounded.
- Execution is offered only by providers that can enforce the requested local boundary. The current registry exposes one `run` mode for Codex because its workspace sandbox permits both edits and local commands; it does not advertise a prompt-only edit mode. Claude is collaboration/review-only until its CLI can enforce an equivalent write boundary.
- There is no executor `full` or pre-approved publish mode. Pull requests are created only from the acceptance endpoint.
- Connector credentials remain in the host and are excluded from agent, GitHub, and publication subprocess environments and prompts.
- Claude project reads use Agent Room's bounded host broker; Claude cannot combine project files with web or connector tools in the same call. Codex project calls run without web or connectors.
- Stored sessions retain up to 200 messages and decisions, 50 terminal executions, and 100 terminal connector actions while preserving pending records. Nested metadata and total session size are bounded.
- Sessions have an explicit schema version. Legacy files are backed up before migration; unreadable files remain visible as recovery entries that can be exported, retried, or explicitly deleted.
- One runtime lock prevents two server processes from writing the same data folder. A stored running discussion is marked interrupted during startup recovery instead of remaining permanently busy.
- Logs rotate locally and diagnostics can be exported explicitly from the setup rail. The JSON export contains bounded redacted log tails and runtime health; it is never uploaded automatically.
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
