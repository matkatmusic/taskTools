# Task 179: Record the real merge commit at merge time so a merged-but-not-closed retry archives the right hash (audit C86-14)

## User request

A merged-but-not-closed retry can archive the wrong commit hash. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-13.

This is finding C86-14 (MEDIUM) in plans/task-86-codex-audit.md.

In mergeTaskDeepestFirst's skipped/no-op branch (scripts/mergeTaskWorktrees.ts:527-549, taken when unmergedCommitCount(sourceCheckoutPath, baseBranch, operationBranch) is 0), the code records `git rev-parse baseBranch` -- the CURRENT source tip -- as the occurrence's oid, on the assumption that the tip is the merge commit. skills/tackle-tasks/task.workflow.js:691-696 then reads rootLayer.oid as the task's mergedCommitHash and passes it to closeTasks as the archived commit hash.

The assumption breaks on retry. If task A merges but closeTasks fails (status merged-but-not-closed), task B later merges and advances baseBranch, and A is then retried, A hits the no-op path and is archived with B's LATER tip instead of the commit that actually merged A.

Existing retry coverage retries before any intervening source advance (tests/taskWorkflowMergeStage.test.ts:174-179), which is exactly why the gap is invisible today.

FIX DIRECTION, settled with the user: record the merge commit AT MERGE TIME and persist it with the task, then have the retry reuse that recorded value. Do not recover it by searching history -- a rebase or squash can make the real merge commit ambiguous or unfindable, which would just reintroduce guessing. The no-op path must stop reporting the current tip as though it were the merge.

## Files

@scripts/mergeTaskWorktrees.ts
@skills/tackle-tasks/task.workflow.js
@tests/mergeTaskWorktrees.test.ts
@tests/taskWorkflowMergeStage.test.ts