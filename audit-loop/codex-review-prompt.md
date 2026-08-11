# Codex review-and-update prompt for Task 86 audit findings 
**Hard rule: agents never commit in the active worktree.** 
Do not run `git commit`, `git commit --amend`, or any equivalent commit-producing command.

Every accepted, rejected, or audit-refresh path ends with a staged handoff and then stops.
A human or external mechanism owns commits.

Replace `[ISSUE_NUMBERS]` with the same JSON array given to the implementation agent, for example `[19]`.
Review one finding per loop unless several findings were explicitly implemented as one inseparable, atomic batch.

## Workflow contract

The implementation agent leaves only its source and regression-test changes staged and does not edit or stage `audit-loop/codex-audit.json`.

Review the staged implementation against the selected audit findings.

DO NOT NITPICK.

The batch has only two outcomes:

- **Accepted:** every selected finding is completely resolved.
Remove the selected entries from the audit JSON, stage that JSON in addition to the implementation, and leave the complete accepted batch staged for handoff.

- **Rejected:** at least one selected finding remains materially unresolved.

Accept none of the batch.
Unstage only the implementation paths without changing their working-tree contents, update the selected audit entries to describe the remaining work, and stage only the audit JSON for handoff.
The implementation remains unstaged for the next repair loop.

Never remove an audit entry unless its implementation and the audit removal will be handed off together in the same staged accepted batch.
Never commit.

## Preflight

Read these files before reviewing:

- `audit-loop/codex-audit-schema.md`

- `audit-loop/codex-audit.json`

- the complete staged diff from `git diff --cached` Run `git status --short`, `git diff --cached --name-only`, and `git diff --name-only`.
Confirm that:

1.
Every requested finding exists exactly once in the audit JSON.

2.
The audit JSON and these prompt files are not staged.

3.
The staged paths contain only the implementation and tests intended for the selected findings.

4.
No staged path also has unstaged changes.
If it does, the working-tree file is not the staged version under review.

If any check fails, stop without changing the index, working tree, or audit.

Report the exact mismatch.
Do not unstage or discard pre-existing user work.

## Review

Review the selected findings against the staged changes and relevant current code.
Judge material correctness, not style preferences.
For each finding, verify all of the following:

- the causal defect is actually removed;

- the production-shaped `provingTest` is covered by a deterministic regression and now has the corrected result;

- every `acceptanceCriteria` item is satisfied, including negative paths, cleanup, state, and reporting requirements;

- the boundaries in `resolvedBoundaryReference` and `resolvedBoundaryExample` remain intact;

- the implementation follows `suggestedFixApproach`, or is demonstrably equivalent without weakening a required guard; - the staged diff contains no unrelated or unowned changes.

Inspect test assertions rather than trusting an `all passing` message.
Run the focused proving tests and `npx tsc --noEmit`.
Run the full suite if the change can affect behavior outside the focused tests.
Preserve and report the actual exit status of every verification command.
If unrelated working-tree changes make a test result ambiguous, do not claim that result as evidence.

Do not reject for optional refactoring, naming preferences, formatting, or other improvements that are not required by the finding.
Do not accept a partial fix merely because the existing suite is green.

## Accepted batch

If every selected finding passes review:

1.
Remove exactly those issue objects from

`audit-loop/codex-audit.json`.

2.
Update document-level verification or notes only as needed to keep them truthful about the revision and commands actually reviewed.

3.
Validate the audit with `jq empty audit-loop/codex-audit.json` and the required-field validation in the schema.

4.
Stage the audit JSON explicitly.
Do not stage any other unstaged file.

5.
Inspect `git diff --cached --check`, `git diff --cached --stat`, and the full cached diff.
It must contain only the reviewed implementation, its tests, and the audit removal/update.

6.
Stop with that accepted set staged.
Do not commit, amend, or continue into another audit item.

Report the accepted finding numbers, staged paths, and verification performed.

The close-time audit refresh happens only after a human or external mechanism commits the accepted batch and starts a new review invocation.

## Rejected batch

If any selected finding fails review:

1.
Record the exact list of implementation paths that were staged at preflight.

2.
Unstage only those paths with `git restore --staged -- <path>...`.
Do not use `git reset`, do not discard their working-tree contents, and do not touch unrelated staged or unstaged work.

3.
Update each unresolved selected issue according to `audit-loop/codex-audit-schema.md`.
Remove claims about portions that are now fixed, but keep the stable issue number.
Refresh `cause`, `locations`, `provingTest`, `suggestedFixApproach`, boundaries, `acceptanceCriteria`, examples, and task overlap wherever the attempted implementation changed the facts.
Do not invent evidence or prescribe unrelated improvements.

4.
For an atomically rejected multi-issue batch, do not remove even a finding that appeared resolved: its implementation is not in the staged handoff.

Record in the audit notes when staged or unstaged attempted changes affect how the remaining findings should be interpreted.

5.
Validate the JSON, stage only

`audit-loop/codex-audit.json`, and verify with `git diff --cached --name-only` and `git diff --cached` that no implementation path remains staged.

6.
Stop with only the audit update staged.
Do not commit or continue into the repair loop while the audit update remains staged.

Report the failed acceptance criteria, the concrete repair required, the staged audit path, and the implementation files left unstaged.
A human or external mechanism must handle the audit-only commit or otherwise clear the index before the Sonnet implementation prompt can run again.

## Close-time audit refresh

After a human or external mechanism commits an accepted batch, begin a new invocation and re-check every remaining audit issue against the new `HEAD`.

Separately inspect staged, unstaged, and untracked state.
Follow the audit update checklist in `audit-loop/codex-audit-schema.md`: refresh stale paths and line anchors, revise causal claims and examples affected by the accepted changes, and re-check open/completed task overlap.

If no remaining entry needs amendment, report `Audit is accurate` and stage nothing.
If amendments are required, validate the JSON, stage only the audit JSON, inspect the cached diff, report the staged audit refresh, and stop.
Do not commit or combine unreviewed implementation work with the staged refresh.

After the staged refresh is handled externally and the index is clean, the next invocation may select the next single finding (or inseparable atomic batch) and return to the implementation prompt.
If the issue array is empty, report that the audit loop is complete.