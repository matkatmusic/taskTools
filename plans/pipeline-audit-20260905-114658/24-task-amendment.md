# Amendment: Task 24 plan — worktree reset and creation are not crash-safe (PRE-12)

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/24-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/24.json and the live tackle-tasks workflow and skill
Sections: 7 | Fixes: 3
Efficacy: 57%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/24-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. RESET_WORKTREE still has no durable intent before deleting its checkpoint

- Evidence: `[scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.ts:11-25, scripts/tackle-tasks/shared/resumeRun.ts:19-49, plans/pipeline-audit-20260905-114658/24-task.md:282-329]`
- The plan claims: rerunning `RESET_WORKTREE.main` directly proves the worktree-deletion crash is recoverable by the next pipeline invocation.
- Actually true: the proposed production change only adds a test kill hook after deletion. It writes no reset intent before `removeWorktreeAndBranch` destroys the worktree and its checkpoint. A normal preamble resume then has no usable worktree and follows the active/no-worktree path that marks the run `agent-failed`; it does not call `RESET_WORKTREE` again. The test manually invoking the same function bypasses the actual automatic-resume failure.

### 2. Successful creation is expected to remove a lease that must remain held

- Evidence: `[scripts/prepareTasks.ts:461-496, scripts/tackle-tasks/shared/createTaskWorktree.ts:182-192, plans/pipeline-audit-20260905-114658/24-task.md:115-129, plans/pipeline-audit-20260905-114658/24-task.md:284-300]`
- The plan claims: after a recovered CREATE_WORKTREE or RESET_WORKTREE succeeds, no `.lease` file remains beside the worktree.
- Actually true: `createWorktreeForGroup` acquires the task lease and returns without releasing it on success, and `createTaskWorktree` records `leaseRunId: runId`. That physical lease is the pipeline's ownership fence and is supposed to survive until final cleanup. Both proposed “no `.lease`” assertions reject the correct successful state.

### 3. The creation journal is deleted before generated-artifact isolation is configured

- Evidence: `[scripts/tackle-tasks/shared/createTaskWorktree.ts:138-165, scripts/tackle-tasks/shared/createTaskWorktree.ts:176-192, scripts/tackle-tasks/shared/writeTaskBrief.ts:63-73, plans/pipeline-audit-20260905-114658/24-task.md:237-280]`
- The plan claims: killing after task-state publication and retrying through the retained journal proves creation is genuinely finished.
- Actually true: the completion-recovery branch deletes the retained journal and returns immediately, without calling `configureGeneratedArtifactIsolation`. On the ordinary path the journal is also unlinked one line before that configuration. A death after state publication can therefore be classified as complete while skip-worktree isolation was never installed; a death after journal unlink has no durable evidence at all. The proposed test checks only path/state/journal, so it misses this incomplete setup.

## Durable fixes

### Fix for issue 1

- Change: Add a reset-intent record outside the worktree, written atomically before the first destructive reset operation and cleared only after replacement creation and state publication complete. Teach the preamble/resume path to reconcile that intent and add a process-kill test that restarts through `PREAMBLE_STATUS_CHECK`, not by directly calling `RESET_WORKTREE.main`.
- Durable because: Recovery authority survives deletion of the worktree and its checkpoint, which is the precise crash boundary being fixed.

### Fix for issue 2

- Change: Change both tests to assert that the one surviving lease names the current run, while only stale prior-run leases, lease guards, and creation/reset journals are absent.
- Durable because: The tests distinguish valid ownership from orphaned metadata instead of treating all lease files as garbage.

### Fix for issue 3

- Change: Make generated-artifact isolation part of journaled completion: configure it before clearing the journal, and make the completed-journal recovery branch idempotently configure it before returning. Add kill points and assertions around state publication, isolation configuration, and journal deletion.
- Durable because: A worktree is never declared fully created until every required setup side effect is either complete or recoverable.

## Sections that hold up

- The existing create journal is written before physical creation — verified against `scripts/tackle-tasks/shared/createTaskWorktree.ts:159-185`
- Retained incomplete create journals are ownership-checked before rollback — verified against `scripts/tackle-tasks/shared/createTaskWorktree.ts:96-156`
- Existing worktree and branch teardown is designed for repeated calls — verified against `scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.ts:17-24`
