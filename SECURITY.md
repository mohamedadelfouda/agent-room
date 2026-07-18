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
- The single-writer runtime lock is advisory (no native `flock`, per the zero-runtime-deps rule): it holds "one writer per data folder" with a bounded, self-healing risk window, not a hard kernel guarantee. Keep the data folder on a local disk — file-sync clients (OneDrive, Dropbox, Google Drive, iCloud) rewrite file metadata out of band and can both corrupt the lock and clobber session writes. Agent Room warns when it detects a synced data folder but does not block startup.
- Claude currently has no execution mode; its project review uses Agent Room's bounded read-only broker with repository settings/hooks disabled.
- On macOS/Linux, Codex run execution relies on the Codex `workspace-write` sandbox (writes confined to the workspace, network denied) and keeps web, connectors, and publication outside the agent step. Windows has no OS sandbox primitive, so `workspace-write` degrades to read-only there; Codex run execution therefore **fails closed** (is refused) by default and is available only when the operator explicitly sets `AGENT_ROOM_ALLOW_UNSANDBOXED_WINDOWS_EXEC`. That opt-in grants model-run commands full, unsandboxed filesystem and network access on the host — containment then rests on the disposable execution clone, explicit project trust, and the MCP/web/features kill-switches, **not** on an OS sandbox, so it should be enabled only for projects you fully trust.
- Desktop builds are not automatically trusted by Windows or macOS unless the maintainer configures signing/notarization credentials.
- Gmail access tokens and Supabase keys grant whatever rights their issuer assigned; use the least-privileged credential available.
- Desktop connector secrets rely on the operating system's secure-storage service. Linux `basic_text` storage is rejected rather than treated as encryption.
