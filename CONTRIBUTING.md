# Contributing

Participation is governed by `CODE_OF_CONDUCT.md`. Report security vulnerabilities through `SECURITY.md`, not a public issue.

## Set up

Use Node.js 22+ and pnpm 10.12.1 (pinned in `package.json`).

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run ci
pnpm lint
pnpm test:coverage
```

Use `pnpm start` for the browser-facing source server. Run `pnpm test:browser` with system Chrome/Edge and `pnpm test:smoke` for the loopback startup check.

## Change boundaries

- Keep provider-specific behavior in `server/adapters/` and provider metadata in `server/providers/registry.js`.
- Keep external-service code in `server/connectors/registry.js`; state-changing actions must use the approval service.
- Do not add publication or remote-write permission to an executor.
- Preserve user-owned changes in a dirty worktree.
- Add focused tests for behavior changes. The cross-platform CI matrix runs syntax and tests on Ubuntu, Windows, and macOS.

## Review gate

This repository uses `.review-gate/GATE.md`. Before every commit or push:

1. Review the diff with the required review agents and relevant guard checklists.
2. Fix real findings.
3. Commit the reviewed change.
4. Attest the exact commit with `.review-gate/review-gate.sh attest --ran ...` as described in the gate file.

Never bypass the hooks with `--no-verify`.

## Pull requests

Keep one coherent change per PR. Explain the user impact, safety boundary, and validation commands. Do not add generated-by, agent, or co-author signatures; repository commits and PRs use only the human contributor's identity.
