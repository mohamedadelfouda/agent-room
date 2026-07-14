# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability or exposed credential. Use GitHub's private vulnerability reporting for this repository. Include affected files/version, reproduction conditions, impact, and a minimal safe proof of concept.

## Threat model

Agent Room treats project files, filenames, Git metadata, agent output, connector input, and web content as untrusted data. It assumes the local operating-system account, installed provider CLIs, Git executable, and Electron package are trusted.

Primary controls include loopback-only HTTP, host/origin/token checks, strict response headers, explicit project trust, provider command allowlists, `shell: false`, purpose-specific environment allowlists, bounded streams/files/timeouts, Windows Job Object or POSIX process-group containment, one atomic writer per session, disposable execution clones with separate Git objects/refs/configuration, immutable reviewed-tree secret scans, and Git fast-forward acceptance with drift checks plus an index lock across ref/index/working-tree refresh. Connector approvals are atomic, and every external write requires a user decision.

## Important limitations

- Agent output can contain sensitive data and is stored in local session JSON.
- Secret scanning is a defense in depth and cannot identify every credential format.
- A disposable clone isolates new Git objects, refs, and configuration; it does not by itself restrict all filesystem reads.
- Claude currently has no execution mode; its project review uses Agent Room's bounded read-only broker with repository settings/hooks disabled. Codex run execution relies on the Codex `workspace-write` sandbox and keeps web, connectors, and publication outside the agent step.
- Desktop builds are not automatically trusted by Windows or macOS unless the maintainer configures signing/notarization credentials.
- Gmail access tokens and Supabase keys grant whatever rights their issuer assigned; use the least-privileged credential available.
- Desktop connector secrets rely on the operating system's secure-storage service. Linux `basic_text` storage is rejected rather than treated as encryption.
