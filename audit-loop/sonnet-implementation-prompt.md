Fix the following audit issues. Never commit in the active worktree.

Read `audit-loop/codex-audit-schema.md`.
The index must be empty before you start; if `git diff --cached --name-only` prints anything, stop.

Capture the output of this command in a temp file, replacing X, Y, ... with the issue numbers:

`jq '.issues[] | select(.number == X or .number == Y or ...)' audit-loop/codex-audit.json`

Read the temp file and create a task list for the issues.
Implement each `.suggestedFixApproach` so that `.provingTest` passes and every `.acceptanceCriteria` is satisfied.
Preserve `.resolvedBoundaryReference` and `.resolvedBoundaryExample`.
Follow the prescribed fixes; do not do work beyond what is required to resolve the selected issues.
Do not edit `audit-loop/codex-audit.json`.

Run focused tests, then typecheck with `npx tsc --noEmit`.
Fix failures before running the full suite:

```bash
test_log="$(mktemp)"
if npm test > "$test_log" 2>&1; then
  echo "all passing"
else
  tail -n 80 "$test_log"
  exit 1
fi
```

When done, stage only the implementation and test changes for these issues.
Do not stage the audit files or use `git add -A`/`git add .`. Do not commit.
