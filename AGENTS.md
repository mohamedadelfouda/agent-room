<!-- review-gate:begin -->
## Review Gate — mandatory before every commit/push

This project uses **review-gate**. Before any `git commit` (or `git push`), you
MUST follow the protocol in **`.review-gate/GATE.md`**:

1. Review the diff using the agents in `.review-gate/agents/` and the guard-skills
   in `.review-gate/skills/` (apply them as checklists over the changed files).
2. Fix every real finding.
3. Acknowledge + verify:
   ```bash
   bash .review-gate/review-gate.sh attest --ran review,clean-code   # add test/docs if those files changed
   ```
4. Then commit/push.

A git hook BLOCKS the commit/push until `attest` records a passing run for the
exact change. It's an honesty gate — do NOT bypass it with `--no-verify`.
Verify commands are in `.review-gate/gate.config.json`.
<!-- review-gate:end -->
