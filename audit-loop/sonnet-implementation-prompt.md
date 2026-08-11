# Sonnet implementation prompt for Task 86 audit findings

**Hard rule: agents never commit in the active worktree.** Do not run
`git commit`, `git commit --amend`, or any equivalent commit-producing command.
This prompt ends with a staged handoff for review.

Replace `[ISSUE_NUMBERS]` below with a JSON array of the audit finding numbers
to implement, for example `[19]`. Implement one finding per loop unless several
findings are inseparable and will be reviewed, accepted, or rejected as one
atomic batch.

Read `audit-loop/codex-audit-schema.md` before making changes. Then capture
the selected findings in a temporary file outside the repository and read it:

```bash
audit_items_file="$(mktemp -t task-86-audit-items.XXXXXX)"
jq --argjson numbers '[ISSUE_NUMBERS]' \
  '[.issues[] | select(.number as $number | $numbers | index($number))]' \
  audit-loop/codex-audit.json > "$audit_items_file"
jq . "$audit_items_file"
```

Verify that the temporary file contains every requested number exactly once.
If a requested finding is absent or duplicated, stop and report that instead
of guessing which finding to implement.

Before editing, run `git status --short` and `git diff --cached --name-only`.
The index must be empty so the later reviewer can inspect only this
implementation. Do not unstage or overwrite pre-existing work. If the index is
not empty, or if an existing unstaged change overlaps a file this work must
edit, stop and report the conflict.

Create a task list covering every selected finding. For each finding:

1. Confirm that its `cause` and `locations` still describe the current code.
2. Implement the smallest coherent fix described by `suggestedFixApproach`.
3. Satisfy every item in `acceptanceCriteria`, not only the positive path.
4. Preserve or extend the invariants in `resolvedBoundaryReference` and
   `resolvedBoundaryExample`.
5. Add or update deterministic regression coverage for `provingTest`, using
   `remainingMinimalExample` as a sketch rather than blindly copying it.

Do not expand the task beyond the selected findings. If the audit entry is
stale, internally contradictory, impossible to implement safely, or requires
work outside its stated approach and acceptance criteria, stop and report the
exact discrepancy so the reviewer can update the audit. Do not edit
`audit-loop/codex-audit.json`; the Codex reviewer owns audit-file changes.

Run focused tests for the changed behavior first. Then typecheck with:

```bash
npx tsc --noEmit
```

Fix typecheck failures caused by this implementation before continuing. Run
the full suite while preserving the test runner's real exit status:

```bash
test_log="$(mktemp -t task-86-tests.XXXXXX)"
if npm test > "$test_log" 2>&1; then
  echo "all passing"
else
  rg -n '^✖' "$test_log" || true
  tail -n 80 "$test_log"
  exit 1
fi
```

Do not stage anything until the focused tests, typecheck, and full suite pass.
Stage files explicitly with `git add -- <path>...`; never use `git add -A` or
`git add .`. Do not stage the audit JSON or either prompt file. Verify the
result with `git diff --cached --check`, `git diff --cached --stat`, and
`git diff --cached`. The staged diff must contain only the implementation and
regression tests for the selected findings.

Do not commit. Leave the implementation staged for Codex review and stop.
Report the finding numbers, files staged, focused tests run, typecheck result,
and full suite result. Remove the temporary files when they are no longer
needed.
