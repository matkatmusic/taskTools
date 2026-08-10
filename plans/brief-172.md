# Task 172: Return typed failure results for cleanup, merge and close so the queue's failure contract is satisfied (audit C86-07)

## User request

Real cleanup, merge, and close failures do not satisfy the queue's failure contract. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-06.

This is finding C86-07 (HIGH) in plans/task-86-codex-audit.md.

The spec requires a concrete lastFailure for every unmerged result and a terminal reason in the final report. The three implemented stage paths do not provide it.

1. cleanupPlanAndBriefFiles in skills/tackle-tasks/task.workflow.js (around lines 656-681) can throw on git rm/commit failures, and that throw escapes runMerge entirely, so a real cleanup failure produces NO queue outcome at all.
2. When mergeTaskDeepestFirst's report has status !== 'merged', runMerge returns it as-is (around :687-690) with failureReason and failedAtStage but no lastFailure -- yet the generated driver in scripts/tackleTasksBrief.ts (the recordStageOutcome step, around lines 143-146) reads result.lastFailure unconditionally.
3. When closeTasks throws or closeResult.closed excludes N, runMerge returns 'merged-but-not-closed' (around :697-701) with closeError or nothing resembling lastFailure, again mismatched with what the driver text and recordMergedNotClosed expect.

Downstream, recordStageOutcome stores the undefined value and buildMergeReport can omit the reason from the JSON entirely (scripts/runMergePhase.ts:100-114 and :136-147).

Coverage today is fake: the queue tests inject synthetic, compliant reasons straight into recordStageOutcome and never pass a real workflow result through the driver. The cleanup test (tests/taskWorkflowMergeStage.test.ts:304-330) treats a rejected workflow promise as sufficient, even though a rejected promise carries no structured result and so cannot be queued, retried, or reported.

Fix: runMerge and cleanupPlanAndBriefFiles's caller must catch and convert each failure into a discrete typed result carrying a concrete lastFailure (and closeError where appropriate), matching what the generated instructions and recordStageOutcome / recordMergedNotClosed / buildMergeReport already assume. Then feed each REAL result through the queue and the final-report path.

Preserve the intended warning-only behavior for failure of the final worktree removal: removeWorktreeAndBranch failure stays a non-fatal cleanupWarning.

## Files

@skills/tackle-tasks/task.workflow.js
@scripts/tackleTasksBrief.ts
@scripts/runMergePhase.ts
@tests/taskWorkflowMergeStage.test.ts
@tests/runMergePhase.test.ts