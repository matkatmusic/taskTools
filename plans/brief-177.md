# Task 177: Stop re-preparing a failed task from force-resetting its retained worktree (audit C86-12)

## User request

Re-preparing a failed task destroys the work that failure handling intentionally retained. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-11.

This is finding C86-12 (MEDIUM) in plans/task-86-codex-audit.md.

createWorktreeForGroup in scripts/prepareTasks.ts, when a task-N worktree already exists, runs `git checkout --force -B task-N <source>` inside it. That discards any commits/files a two-lap failure intentionally left behind for inspection or recovery.

tests/prepareTasks.test.ts's test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip currently asserts the prior commit and file are gone after re-preparation, so the test validates the data loss rather than the failure-retention contract; it needs to become a retention/recovery assertion instead.

The fix must either preserve/reuse the failed worktree's work or require an explicit cleanup/reset decision before discarding it, rather than doing so silently during normal preparation.

Blocked by the C86-11 task (task 176): that task teaches --discover/findUnmergedTaskWorktrees to recognize task-N worktrees, which this fix's recovery path is expected to build on.

## Files

@scripts/prepareTasks.ts
@tests/prepareTasks.test.ts