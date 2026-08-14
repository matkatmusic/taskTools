# Phase 12 audit

Review target: frozen tree `10b043483409ed036d976d6ecb931741680d23d6`
(`f628d22`, `Phase 12 WIP`), compared with Phase 12 of
`plans/tackle-tasks-v1_5-plan.md` and the authoritative control flow and global rules in
`plans/diagram/pipeline.mmd`.

## Findings

### 1. The end-to-end driver skips required green boxes and does not follow the diagram's control flow

Phase 12 requires the test repository to be driven by calling the green-box scripts in diagram
order. The new `runPipeline` claims to do that, but its imports and straight-line path omit
`amendExitNotesIntoBrief`, `updateTaskDocs`, `resetTaskWorktree`, `validatePlanFile`,
`validateCodexReview`, `applyPlanAmendments`, and `recordImplementationNotes`
(`tests/tackle-tasks/pipeline.e2e.test.ts:10-35,204-225`). On an existing worktree it always
calls `isTaskRunResumable` after a safe verdict and then calls `generateTaskDocs`, whereas the
diagram's safe path establishes the lease and enters `updateTaskDocs`; the unsafe path is the
one that decides resumable versus reset.

The driver also substitutes immediate exits for the diagram's repair/retry transitions: the
first red task-test result becomes `tests-red`, the first red full-suite result becomes
`suite-red`, the first unresolved advance becomes `rebase-stuck`, and the first failed merge
becomes `merge-failed` (`:225-253`). The diagram requires the respective commit/repair loops and
their two-attempt caps. There is no lost-mutation reconciliation anywhere in the driver. Thus
the twelve green tests can pass if orchestration omits a required state mutation, uses the wrong
existing-worktree branch, or exits on the first recoverable failure. They are a partial script
composition test, not the end-to-end diagram proof Phase 12 requests.

Make the agentless driver follow the diagram node for node on every path the Phase 12 scenarios
visit. Represent yellow-box work with deterministic fixture callbacks that write the expected
plan/review/implementation/repair artifacts, but call every surrounding green-box script in its
specified position. Implement the specified branch decisions, counters, commits before retests,
source-lock handling, and lost-result reconciliation rather than shortening those transitions.
Add a visit trace (full box labels or script names) and assertions for the successful, retained
worktree, red-suite, and archive-loss scenarios that prove the exact relevant diagram order and
prove no required green box was skipped.

### 2. The two “every exit path” tests cover only a minority of the required exits

The diagram says every exit except `invalid-number`, `not-open`, and `already-active` runs the
common state-writing exit chain. `test_pipeline_leavesTheTaskInactiveAfterEveryExitPathThatWritesState`
checks only `blocked`, `suite-red`, `fence-violation`, and `completed`
(`tests/tackle-tasks/pipeline.e2e.test.ts:361-392`). It never exercises `plan-scrapped`,
`tests-red`, `tests-flagged`, `rebase-stuck`, `merge-failed`, or `run-failed`. Likewise,
`test_pipeline_releasesTheSourceLockOnEveryExitPath` checks only `suite-red`,
`fence-violation`, and `completed` (`:394-412`), omitting failures at rebase/advance/merge and
an operational failure after the lock is acquired. A regression that strands one of those
runs active or leaks the durable source lock therefore still leaves both tests green.

Turn these into table-driven end-to-end scenarios covering every diagram exit that writes run
state. For each, assert the exact exit type/note, `active:false`, and that neither lease nor
source lock remains owned by the run. Include operational `run-failed` injections in the
claimed/no-worktree, claimed/with-worktree, and post-inactivation cases, and include every exit
reachable after source-lock acquisition (`suite-red`, `rebase-stuck`, `merge-failed`,
`fence-violation`, post-lock `run-failed`, and `completed`). Keep explicit assertions that the
three non-writing exits do not alter another run's state.

### 3. The archive-loss test never loses a result, and the driver would misreport a landed archive as failed

The required `test_pipeline_recognizesACompletedArchiveWhenTheResultIsLost` completes an ordinary
pipeline run and then directly calls `closeTaskRun` a second time
(`tests/tackle-tasks/pipeline.e2e.test.ts:471-485`). That proves the close wrapper is idempotent;
it does not prove the pipeline recognizes a lost result. In the driver, a null/throwing close
result is caught and immediately converted to a reopened `run-failed` record
(`:267-280`). If the archive actually landed before its result disappeared, the task is already
absent from `tasks.json`; diagram rule 11 instead requires `reconcileStep` to observe the
completed archive and continue the completed edge. The current test cannot fail when that
pipeline behavior regresses because it never enters the loss branch.

Inject a close operation that performs the real mutation and then drops its return value. Pass
the original payload and stable `stepId` through the real read-only reconciliation path, assert
that reconciliation returns `completed` with the reconstructed close result, and let the driver
finish as `completed` without calling `writeTaskExitNotes({reopen:true})`. Prove the task is
absent from `tasks.json`, present exactly once in `completedTasks.json`, and retains the original
completed run outcome. Preserve a separate ambiguous/failing-archive scenario for the required
post-inactivation `run-failed` behavior.

### 4. The resume test stops after a direct lease call and never proves that the resumed pipeline can finish

`test_pipeline_resumesAPreviousRunAndAdoptsItsWorktreeLease` ends after directly calling
`claimTaskRun`, `doesTaskWorktreeExist`, and `isTaskRunResumable`
(`tests/tackle-tasks/pipeline.e2e.test.ts:488-507`). It does not assert that the prior work is
actually resumable, does not enter the driver's existing-worktree path, does not prove both the
task-state and physical lease name the new run before `updateTaskDocs`, and never reaches real
cleanup. Consequently it cannot catch the owner-mismatch failure that occurs when a later
cleanup tries to release an old run's lease, nor can it catch the driver's wrong docs branch.

Have the first run record a real implementation-notes file and retain its safe worktree and old
physical lease. Drive the second run through the complete agentless pipeline. Immediately before
the real `updateTaskDocs` call, assert `resumable:true` and that both
`task.run.leaseRunId` and `<worktree>.lease` name the second run. Then finish through real merge,
cleanup, and archive; assert `completed`, the retained worktree and lease are gone, the source
lock is released, and no owner-mismatch or `run-failed` outcome occurred.

### 5. The concurrent-worktree test executes both creations serially

`test_pipeline_runsTwoTaskWorktreeCreationsConcurrentlyWithoutInterference` wraps two synchronous
`createTaskWorktree` calls in already-resolved promise callbacks
(`tests/tackle-tasks/pipeline.e2e.test.ts:529-543`). JavaScript runs each callback to completion
on the same thread before starting the next one, and `createTaskWorktree` is synchronous. The
observed distinct worktrees therefore prove only sequential creation; the race that requirement
`[a3 16]` is meant to expose never occurs.

Run the two real script CLIs in separate child processes (or workers) and use a test-only barrier
immediately before the contended creation section so both invocations have started before either
is allowed to finish. Assert overlap explicitly, wait for both successful JSON results, and then
retain the existing distinct-worktree/branch/task-state assertions. The test must fail if the
second creation starts only after the first has completed.

## Verification performed

- Frozen review tree: `10b043483409ed036d976d6ecb931741680d23d6`; it is the tree of commit
  `f628d22962fe3ed1dcfb33107a21bbaaedef62dd`.
- `node --test tests/tackle-tasks/pipeline.e2e.test.ts` — 12 named Phase 12 tests passed.
- `npx tsc --noEmit` — passed.
- Phase 12's required initial suite command,
  `npm test 2>&1 | rg -e '^✖' || echo "all passing"` — reported `all passing`.
- Static comparison of `runPipeline` and its imports with the diagram's green boxes and
  transition rules produced the gaps above.

The green suite does not resolve these findings because the missing branches and concurrency
are precisely the behaviors the current fixtures never execute.
