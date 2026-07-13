# Agent Room

A local, private workspace where two AI coding agents (**Claude Code** + **Codex CLI**)
work in **one persistent session** — using *your own subscriptions* — and **you stay the
decision‑maker**.

They plan together (collaborate or debate). When it's time to act, **you pick one executor
and one reviewer**. Only the executor writes; the reviewer reads. Never two writers.

Runs on `127.0.0.1` with **no cloud backend of its own** and **no API keys** — it uses your
Claude and Codex subscriptions. It does **not** send your data to any Agent Room server.
It **does** send your prompts and project context to Anthropic and OpenAI through their
official `claude` / `codex` CLIs — exactly as if you ran those tools yourself. Sessions are
stored locally as plain‑text JSON.

---

## Why

Juggling two AI agents means copy‑pasting a plan back and forth between tools. Agent Room
puts them in one shared session, keeps the context when you switch how they collaborate,
and gives you a safe way to let one of them actually do the work.

## Features

**Plan together**
- One session, switchable modes: **Collaboration** and **Debate**, context kept across switches
- Each agent's model and effort are configurable per round
- Clean errors, run metadata (model / effort / duration), connection status
- Bidirectional UI: Arabic (RTL) and English (LTR), agent output stays in your language

**Execute & Review (single writer)**
- You choose **one executor** and **one reviewer** — two agents never write at once
- The executor works in an isolated **git worktree** with a permission mode you pick:
  `edit` (files) · `run` (files + commands) · `full` (+ push / PR)
- **Approval before any write**, then a diff you review
- Accept = merge locally, or **open a GitHub Pull Request** (via `gh`); reject = discard the worktree
- The reviewer is always read‑only

**Setup**
- First‑run onboarding auto‑detects the Claude / Codex CLIs and your GitHub auth

## Requirements

- **Node.js 20+**
- **Claude Code** — installed and logged in (`claude`)
- **Codex CLI** — installed and logged in (`codex login`)
- **GitHub CLI** (`gh`) — logged in, only if you want to open PRs

No npm dependencies. Nothing to install beyond the CLIs above.

## Run

```bash
npm start
```

Then open http://127.0.0.1:3210

On Windows you can also double‑click `start-windows.bat`; on macOS, `start-macos.command`.

## How it works

- A small local Node server (`server/`) drives the official CLIs as child processes, streams
  their output, and stores each session as JSON under `data/sessions/` (git‑ignored).
- The UI (`public/`) is plain HTML / CSS / JS — no build step.
- Execution runs in a git **worktree** under `.agent-workspaces/<agent>/<task>`, so the
  executor's **code changes** are kept off your working tree until you accept. A worktree
  isolates Git changes — it is **not** a security sandbox (the process can still read other
  files, the network, and env); read‑only planning and per‑run permissions are what limit
  what an agent can do.

See [DESIGN.md](DESIGN.md) for the design system and [EXECUTION.md](EXECUTION.md) for the
execute‑and‑review model.

## Safety

- Agents default to **read‑only** for planning; write access is granted only to the one
  executor you pick, for one run, inside an isolated worktree.
- Secrets and personal paths are redacted from logs and error details. Only agents' final
  answers are saved to sessions — their step‑by‑step reasoning is not persisted.

## License

MIT © Mohamed Adel Fouda
