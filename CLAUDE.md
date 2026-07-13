<!-- review-gate:begin -->
## Review Gate (MANDATORY — every session, automatic)

This project uses **review-gate**. Before any `git commit` (or `git push`), you
MUST follow the protocol in **`.review-gate/GATE.md`** — do it first, even if the
user only says "commit"/"push":

1. Spawn the relevant review agents IN PARALLEL over the diff (they live in
   `.claude/agents/`): `code-reviewer` + `security-reviewer` always, plus
   `performance-reviewer` / `database-reviewer` / `accessibility-reviewer` /
   `i18n-reviewer` / `refactor-cleaner` when the change touches those areas. Also
   run the guard-skills (`clean-code-guard` / `test-guard` / `docs-guard`).
2. Self-review the diff and reconcile every finding; fix the real ones.
3. Acknowledge + verify (attest):
   ```bash
   bash .review-gate/review-gate.sh attest --ran review,clean-code   # add test/docs if those changed
   ```
4. Then commit/push.

A PreToolUse hook (and a git hook) BLOCK the action until `attest` records a
passing run for the exact change. Any new commit invalidates the marker. It's an
honesty gate — do NOT bypass it. Verify commands: `.review-gate/gate.config.json`.
<!-- review-gate:end -->
