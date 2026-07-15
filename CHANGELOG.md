# Changelog

## Unreleased

- Added in-app CLI setup: read-only discovery of native provider executables hidden behind npm/pnpm shims (such as a global Codex install on Windows), one-click Trust & check from a discovered path, and per-provider install guidance in the settings drawer and onboarding checklist.

## 0.2.1 — 2026-07-15

- Rejected `.git/commondir` redirection in execution clones so an untrusted executor cannot re-link a disposable clone to the source object store.
- Made desktop code signing optional and published unsigned tagged builds as pre-releases instead of failing the release.
- Fixed the macOS (`.zip`) and Linux (`.deb`/`.rpm`) installer builds so tagged releases produce artifacts on all three platforms.

## 0.2.0 — 2026-07-14

- Added goal-aware, proposal-versioned collaboration control blocks and neutral decision briefs.
- Added trusted shared evidence packs, capability routing, round summaries, and a user decision log.
- Moved Git commit creation to acceptance with immutable-tree secret scanning and drift checks.
- Isolated every execution in a disposable clone so rejected and packed secret objects never enter the project repository, and bound acceptance to the exact reviewed tree.
- Added a provider registry with dynamic provider/model UI.
- Added opt-in GitHub, Gmail, and Supabase connector actions with MCP proposals and explicit approval.
- Added OS-encrypted desktop connector settings and visible crash-uncertain action recovery states.
- Added Electron Forge packaging for Windows, macOS, and Linux plus native CI release builds.
- Added WCAG 2.1 AA keyboard, focus, contrast, reduced-motion, and live-region support across the desktop UI.
- Added parity-checked Arabic/English UI catalogs with localized errors, connector actions, decision states, numbers, and durations.
- Added host-brokered project/MCP tools so credentials stay in the host and project reads remain separate from web/connector calls.
- Added atomic accept/reject and connector approval state transitions, locked/CAS Git fast-forward acceptance, and crash-safe cleanup after terminal decisions.
- Added cross-kind session admission, latest-only session loading, action-specific stop controls, background startup recovery, and visible non-zero desktop startup failures.
- Bounded agent output, lines, final-response files, sessions, connector responses, Windows/POSIX process trees, and call duration.
