# Amendment: Task 16 plan — cleanup loses its resume cursor; rebase never releases the source lock on crash

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/16-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/16.json and the live codebase
Sections: 7 | Fixes: 2
Efficacy: 71%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/16-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. A cleanup retry cannot reacquire the lock that the failed attempt released

- Evidence: `[scripts/tackle-tasks/shared/cleanupTaskWorktree.ts:68-85, scripts/tackle-tasks/shared/sourceRepoLock.ts:176-193, plans/pipeline-audit-20260905-114658/16-task.md:363-391]`
- The plan claims: a retained tail cursor can replay `CLEAN_UP_WORKTREES` directly, and the retry in the proposed test succeeds after merely unlocking the worktree.
- Actually true: `cleanupTaskWorktree` releases the source lock in its catch, while its next invocation calls `refreshOwnedSourceRepoLockOrThrow` rather than acquiring the now-absent lock. The proposed retry therefore throws before cleanup. A cursor that bypasses `LOCK_SOURCE_REPO` needs an explicit, ownership-checked reacquisition path.

### 2. The regression test never exercises the crash window named by the task

- Evidence: `[scripts/tackle-tasks/shared/cleanupTaskWorktree.ts:75-98, plans/pipeline-audit-20260905-114658/16-task.md:363-393]`
- The plan claims: it tests a crash after worktree deletion and proves resume continues cleanup.
- Actually true: the proposed test locks the worktree, so `removeTaskWorktreeAndBranches` throws and the worktree remains. It tests a cleanup failure before deletion, not the critical state where cleanup deleted the worktree and its checkpoint but the wrapper died before clearing the external cursor.

## Durable fixes

### Fix for issue 1

- Change: Amend Step 3 so every `CLEAN_UP_WORKTREES` attempt first obtains or confirms the source lock for `buildLockOwner(runId, taskNumber)` before calling `cleanupTaskWorktree`. A lock held by another owner must leave the cursor intact and fail without mutation. Update the retry test to assert that the first failure released the lock and that the replay reacquires it before succeeding.
- Durable because: every entry path, including direct cursor resume after the cleanup catch released ownership, establishes the same lock precondition before destructive cleanup.

### Fix for issue 2

- Change: Add a separate test that writes the cleanup cursor, invokes `cleanupTaskWorktree` directly to completion to simulate death between its return and the wrapper's cursor clear, verifies the worktree/checkpoint are gone while the cursor remains, calls `findResumeEntry`, and replays `CLEAN_UP_WORKTREES` from that returned cursor through to a cleared cursor and empty retained-artifact set.
- Durable because: the test pins the exact post-deletion/pre-clear state that caused the original loss of resumability, rather than a neighboring failure mode.

## Sections that hold up

- Rebase lock leak and catch/rethrow repair — verified against `scripts/tackle-tasks/shared/rebaseTaskWorktree.ts:170-218` and `scripts/tackle-tasks/shared/sourceRepoLock.ts:187-193`
- External cursor storage and newest-run fencing — verified against `scripts/tackle-tasks/shared/taskRunState.ts:526-553`
- Tail-cursor priority over a stale worktree checkpoint — verified against `scripts/tackle-tasks/shared/resumeRun.ts:13-49`
