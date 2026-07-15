# Mission Control UI — Handoff

Branch: `ui/mission-control` · Base: `main` · Status: **work in progress (structure landed, JS wiring pending)**

This document is the single source of truth for finishing the "Mission Control" UI. Read it fully before touching `public/`.

## Goal

Make the full **Mission Control decision-room mockup** the real Agent Room UI, wired to the real backend, with **no fabricated data** and **no lost functionality**.

- Mockup file (design reference, static demo): `C:/Users/moham_ub2xpub/Downloads/agent-room-decision-room-v1.html`
- Target surfaces: `public/index.html`, `public/styles.css`, `public/app.js`, `public/strings.js`.

## Decisions already made with the user (do not re-litigate)

1. **Full merge**: reproduce the mockup layout AND keep every existing real feature (onboarding, exec drawer, connectors, project picker, round modes). Nothing is dropped.
2. **No fabricated data**: regions the backend cannot feed yet (evidence table, risk card, per-stage timestamps) are shown as explicit **"قريباً / Coming soon"** placeholders, never fake rows.
3. **Phase is derived, not manual**: the mockup's phase switch becomes a **read-only derived indicator** from real session state.

## Binding map (mockup region → real data source)

| Mockup region | Real source |
| --- | --- |
| Phase pill (`#statusPill`) + `html[data-phase]` | Derived: `running`→collaboration, converged/idle→decision, executing/awaiting_user→execute |
| Workflow stages (`#stageList`) | Derived from session lifecycle (done/active), timestamps = "قريباً" |
| Decision agent cards (`#agentGrid`, `.dcard`) | Latest real message per agent (Claude/Codex) from `currentSession.messages` |
| Approval gate (`#approvalHost`, `.approval`) | Real execution `awaiting_user` → reuse `acceptExec`/`rejectExec` |
| Live strip (`#liveStrip`) | Real running agents via SSE (`agent_start`/`agent_activity`) |
| Context cards (goal/project/log) | Already wired in `renderContextColumn()` — keep |
| Evidence table, risk card, stage times | "قريباً" placeholders (`#evidenceSoon`) |
| Presets (Simple/Builder/Mission) | Real persisted layout-density pref → `html[data-preset]` |
| View tabs (Decision/Conversation) | Toggle `[data-view-panel]`; conversation = existing `#chat` |
| Theme toggle (`#themeBtn`) | `html[data-theme]` + localStorage |

## What the PREVIOUS session (`a4e00bd`) did

- Built the 2-zone shell (rail + main with chat + context), setup/exec drawers, all modals, and the round CRUD. **This works.**
- Wrote a **complete stylesheet** (`public/styles.css`) that already includes styles for the whole decision room: `.dcard`, `.dcard-head/-body/-empty/-foot`, `.stage`, `.stage-dot`, `.live-strip`, `.live-actor`, `.approval`, `.approval-lock`, `.view-tab`, `.gate-tag`, `.pill` with `html[data-phase]`, `.preset`, `.drawer`/`.backdrop`, presets density rules.
- **Gap (the bug to fix):** those decision-room regions were **never added to the HTML and never wired in `app.js`** (grep confirms zero references to `statusPill`, `stageList`, `dcard`, view tabs, `liveStrip`, presets, theme in `app.js`). The CSS was written ahead of the markup/JS.

## What THIS session added (already in the working tree, verified well-formed)

Edits to `public/index.html` only. a11y-markup test passes (2/2); block tags balanced.

- Topbar: `#statusPill` (phase pill), `#themeBtn`, `#presetsBtn`.
- Restructured `.session-body` → **`.workspace` 3-column grid**:
  - `aside.workflow#workflow` → `#stageList` + "قريباً" note.
  - `.main-inner#mainInner` → `.decision-bar` (`#mainHeading`, `#mainSub`, `#gateTag`) + `.view-tabs` (`#tabDecision`, `#tabConversation`) + `#decisionPanel` (`#liveStrip`, `#agentGrid`, `#approvalHost`, `#evidenceSoon`) + `#conversationPanel` (existing `#chat`).
  - `aside#contextCol` (unchanged, still populated by `renderContextColumn`).
- Presets drawer `#presetsDrawer` + `#backdrop` (buttons `#closePresets`, `#closePresets2`, `.preset[data-preset]`).

**These new controls are currently INERT** — the JS to wire them is not written yet. That is the remaining work.

## Remaining work (do this, in order)

### 1. CSS (`public/styles.css`) — small
- Add `.main-inner { min-width:0; min-height:0; overflow:auto; display:grid; gap:10px; align-content:start; padding:12px; }`.
- Add `[data-view-panel][hidden]{display:none!important}` and give `#decisionPanel`/`#conversationPanel` `display:grid; gap:10px`.
- Verify `.session-view` padding does not double-inset the full-bleed `.workflow`/`.context-col` columns; likely move padding off `.session-view` and onto `.main-inner`/`.decision-bar`. **Test visually.**

### 2. `public/app.js` — the core wiring
Add and hook these (reuse existing helpers `t`, `esc`, `bdi`, `providerInfo`, `phaseLabel`):
- `derivePhase(session)` → `"collaboration" | "decision" | "execute"` and `applyPhase()` sets `document.documentElement.dataset.phase`, `#statusPill` text, `#mainHeading/#mainSub`, `#gateTag` visibility.
- `renderStages()` → build `#stageList` buttons (Plan/Collab/Decision/Execute/Review/Accept) with `.is-done/.is-active` from derived phase. No timestamps (coming soon).
- `renderDecisionCards()` → for each provider, latest agent message → `.dcard` in `#agentGrid`; empty → `.dcard-empty`.
- `renderApprovalGate()` → if an execution is `awaiting_user`, render `.approval` into `#approvalHost` with buttons calling existing `acceptExec(taskId, 'merge'|'pr')` / `rejectExec(taskId)`. Otherwise empty (executions still render in `#chat` via `renderExecutions`).
- `setView(view)` → toggle `[data-view-panel]` `hidden` + `aria-selected` on `#tabDecision/#tabConversation`. Default: `decision`.
- `setPreset(id)` / theme toggle → `dataset.preset`/`dataset.theme` + localStorage (mirror `applyShellChrome`).
- Live strip: in `handleEvent` `agent_start`/`agent_activity`/`agent_complete`, update `#liveStrip` (show while running, hide when idle).
- **Call `applyPhase()` + `renderStages()` + `renderDecisionCards()` + `renderApprovalGate()` from inside `renderMessages()`** (already the single re-render point) and on `loadSession()`.
- Wire new buttons in the "wiring" section: `#themeBtn`, `#presetsBtn`/`#closePresets`/`#closePresets2`/`#backdrop`, `.preset`, `.view-tab`, and add theme/preset load in `initialize()`.

### 3. `public/strings.js` — i18n (AR + EN, MUST stay at parity)
Add keys used by the new markup (both languages): `theme`, `customize`, `customizeSub`, `close`, `done`, `workflowNav`, `workflow`, `stageTimesSoon`, `gateTag`, `viewTabs`, `tabDecision`, `tabConversation`, `evidence`, `soon`, `evidenceSoon`, `presetSimple`, `presetSimpleDesc`, `presetBuilder`, `presetBuilderDesc`, `presetMission`, `presetMissionDesc`, plus stage labels (`stagePlan`, `stageCollab`, `stageDecision`, `stageExecute`, `stageReview`, `stageAccept`) and approval-gate copy. `test/unit/i18n.test.js` enforces AR/EN key parity — run it.

## Guardrails (non-negotiable)

- **Preserve every existing element ID and flow** in `app.js` (SSE, execution accept/reject, connectors, onboarding, project picker, focus-trapped modals). Do not rename IDs the JS depends on.
- **AR/EN RTL parity** and **WCAG 2.1 AA** (every control labeled; the a11y-markup + i18n tests must pass).
- **Security model unchanged** — this is a frontend-only change; do not touch the server auth/exec/connector contracts.
- **Review gate before any push**: follow `.review-gate/GATE.md` (spawn `code-reviewer` + `security-reviewer`, run `clean-code`/`i18n`/`accessibility` reviewers, then `attest`). Needs network for the review agents.
- **Verify**: `npm run check` + `npm test` (196 tests) must stay green; then run the app and screenshot the three phases before calling it done.

## Quick verify commands

```bash
npm run check                                   # syntax (offline)
npm test                                        # full suite incl. a11y + i18n parity (offline)
node --test test/unit/accessibility-markup.test.js
node --test test/unit/i18n.test.js
```
