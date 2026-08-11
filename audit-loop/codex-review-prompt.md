Review `audit-loop/codex-audit.json` items X, Y, ... against the staged changes.
Never commit in the active worktree. Do not nitpick.

Read `audit-loop/codex-audit-schema.md`, the selected issues, and `git diff --cached`.
Confirm the audit file is not staged, the staged files belong only to these issues, and no staged file also has unstaged changes. Stop and report any mismatch without changing files or the index.

For each issue, verify that:

- the cause is removed;
- `.provingTest` has deterministic regression coverage and passes;
- every `.acceptanceCriteria` is satisfied;
- `.resolvedBoundaryReference` and `.resolvedBoundaryExample` are preserved;
- the staged diff contains no unrelated changes.

Run the focused proving tests and `npx tsc --noEmit`. Run the full suite when the changes can affect behavior outside the focused tests. Do not accept a partial fix because the suite is green, and do not reject for optional improvements.

## No fixes needed

If every selected issue is completely resolved:

1. Remove exactly those issues from `audit-loop/codex-audit.json`.
2. Update audit verification notes only as needed to keep them accurate.
3. Validate the JSON and the required-field check in the schema.
4. Stage the audit file alongside the reviewed implementation.
5. Verify the staged diff contains only the implementation, tests, and audit update.
6. Stop and report the accepted issue numbers, staged files, and verification performed. Do not commit.

## Fixes needed

If any selected issue is not completely resolved, reject the batch:

1. Record the staged implementation paths, then unstage only those paths with `git restore --staged -- <paths>`. Do not discard their working-tree changes.
2. Update unresolved issues to describe only the remaining problem and required fix, following the schema. Keep all selected issue entries when an atomic multi-issue batch is rejected.
3. Validate the JSON and stage only `audit-loop/codex-audit.json`.
4. Verify no implementation file remains staged.
5. Stop and report the failed criteria, required fixes, staged audit file, and implementation files left unstaged. Do not commit.

## Audit refresh

When invoked after an accepted batch was committed externally, check every remaining audit issue against the new `HEAD` and separately inspect staged, unstaged, and untracked changes. Amend stale issues according to the schema.

If nothing changed, report `Audit is accurate`. Otherwise validate and stage only `audit-loop/codex-audit.json`, then stop and report the update. Never commit.
