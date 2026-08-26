# Appendix: per-block facts, measured 2026-08-26 against the v1.5 code now under archive/tackle-tasks-v1_5/.
# Every `scripts/steps/...`, `scripts/tackle-tasks/...`, `tackle-tasks/...` path below is relative to archive/tackle-tasks-v1_5/scripts/ now.

# monolith-pipeline.ts block-by-block spec
File: scripts/tackle-tasks/monolith-pipeline.ts (1349 lines). blocks map at line 136-807.
blockInputFields map at lines 858-974. Diagram: plans/diagram/_pipeline-monolith.mmd.

## PREAMBLE_STATUS_CHECK
- Mock lines: 138-245
- blockInputFields: `PREAMBLE_STATUS_CHECK: ["taskNumber", "tasks", "runId"]`
- live comments (verbatim, in order):
  `live: steps/pipeline-preambleStatusCheck/IS_TASK_NUMBER_VALID.ts -> tackle-tasks/isTaskNumberValid.ts` | `live: IS_TASK_BLOCKED.ts -> tackle-tasks/isTaskBlocked.ts -> checkBlockers.ts:blockerReport` | `live: IS_TASK_ACTIVE.ts -> taskRunState.ts:readTaskRunState; MARK_TASK_ACTIVE.ts -> taskRunState.ts:claimTask, one atomic write` | `live: steps/pipeline-worktreeCheck/DOES_WORKTREE_EXIST.ts -> tackle-tasks/doesTaskWorktreeExist.ts` | `live: CREATE_WORKTREE.ts -> _createFreshTaskWorktree.ts, TAKE_WORKTREE_LEASE.ts; ponytail: fake path, real: prepareTasks.ts:resolveTaskWorktreeConventionDirectory` | `live: IS_WORKTREE_SAFE_TO_USE.ts -> checkTaskWorktreeSafe.ts; TAKE_WORKTREE_LEASE_BEFORE_RESET.ts -> taskRunState.ts:transitionWorktreeLease; RESET_WORKTREE.ts` | `live: IS_PREVIOUS_RUN_RESUMABLE.ts -> isTaskRunResumable.ts, which adopts the lease first` | `live: DOES_FENCE_COVER_WORKTREE.ts -> checkResumedWorktreeFence.ts` | `live: INIT_SUBMODULES_RECURSIVELY.ts -> tackle-tasks/initTaskSubmodules.ts, writes a step receipt`
- Diagrams/boxes absorbed (per _pipeline-monolith.mmd header: "One block for pipeline-preambleStatusCheck.mmd, pipeline-worktreeCheck.mmd, and init submodules"):
  pipeline-preambleStatusCheck.mmd boxes: PREAMBLE_TASK_NUMBER_INPUT, IS_TASK_NUMBER_VALID, IS_TASK_BLOCKED, IS_TASK_ACTIVE, MARK_TASK_ACTIVE, WORKTREE_CHECK_PIPELINE, REPORT_ONLY_EXIT (REPORT_ONLY_EXIT is its own monolith block, see below) | pipeline-worktreeCheck.mmd boxes: ACTIVE_TASK_INPUT, DOES_WORKTREE_EXIST, IS_WORKTREE_SAFE_TO_USE, IS_PREVIOUS_RUN_RESUMABLE, DOES_FENCE_COVER_WORKTREE, CREATE_WORKTREE, TAKE_WORKTREE_LEASE, TAKE_WORKTREE_LEASE_BEFORE_RESET, RESET_WORKTREE, INIT_SUBMODULES_RECURSIVELY, DOCUMENT_GENERATION_PIPELINE, FAILURES_EXIT (local re-export) | cross-checked against scripts/steps.json keys "pipeline-preambleStatusCheck.mmd" and "pipeline-worktreeCheck.mmd" (dir listings match 1:1).
- Decisions / next values and conditions:
  task not found in tasks -> `next: REPORT_ONLY_EXIT`, exitType "invalid-number" | any blocker still open -> `next: REPORT_ONLY_EXIT`, exitType "blocked" | run.active === true -> `next: REPORT_ONLY_EXIT`, exitType "already-active" | run.worktree undefined (fresh) -> docsMode "AUTOGEN", falls through to next: DOCUMENT_GENERATION | run.worktreeSafe !== true (reset) -> docsMode "AUTOGEN", falls through | else (resumable branch): newest ended run has no implementationNotesFile -> `next: FAILURES_EXIT`, exitType "not-resumable" | resumed worktree touched a file outside task.files -> `next: FAILURES_EXIT`, exitType "fence-violation" | else docsMode "UPDATE" | success path -> `next: DOCUMENT_GENERATION` with `docsMode`
- Real helper functions the current fine-grained scripts call (imports + main call):
  IS_TASK_NUMBER_VALID.ts: imports `isTaskNumberValid` from tackle-tasks/isTaskNumberValid.ts, `taskFilesProjectRoot` from taskFiles.ts | IS_TASK_BLOCKED.ts: imports `isTaskBlocked` from tackle-tasks/isTaskBlocked.ts, `taskFilesProjectRoot` from taskFiles.ts | IS_TASK_ACTIVE.ts: imports `readTaskRunState` from tackle-tasks/taskRunState.ts, `taskFilesProjectRoot` from taskFiles.ts | MARK_TASK_ACTIVE.ts: imports `claimTask` from tackle-tasks/taskRunState.ts, `taskFilesProjectRoot` from taskFiles.ts | DOES_WORKTREE_EXIST.ts: imports `doesTaskWorktreeExist` from tackle-tasks/doesTaskWorktreeExist.ts | CREATE_WORKTREE.ts: imports `createFreshTaskWorktree` from ./_createFreshTaskWorktree.ts (which itself imports `createWorktreeForGroup` from prepareTasks.ts, `configureGeneratedArtifactIsolation` from tackle-tasks/writeTaskBrief.ts, `readTaskFile/resolveTaskFiles` from taskFiles.ts) | TAKE_WORKTREE_LEASE.ts: imports `updateCurrentTaskRun` from tackle-tasks/taskRunState.ts | IS_WORKTREE_SAFE_TO_USE.ts: imports `checkTaskWorktreeSafe` from tackle-tasks/checkTaskWorktreeSafe.ts | TAKE_WORKTREE_LEASE_BEFORE_RESET.ts: imports `readTaskRunState, transitionWorktreeLease` from tackle-tasks/taskRunState.ts, `releaseTaskWorktreeLease` from prepareTasks.ts | RESET_WORKTREE.ts: imports `deleteTaskMergePersistence, removeWorktreeAndBranch` from mergeTaskWorktrees.ts, `updateCurrentTaskRun` from tackle-tasks/taskRunState.ts, `createFreshTaskWorktree` from ./_createFreshTaskWorktree.ts | IS_PREVIOUS_RUN_RESUMABLE.ts: imports `isTaskRunResumable` from tackle-tasks/isTaskRunResumable.ts | DOES_FENCE_COVER_WORKTREE.ts: imports `checkResumedWorktreeFence` from tackle-tasks/checkResumedWorktreeFence.ts | INIT_SUBMODULES_RECURSIVELY.ts: imports `initTaskSubmodules` from tackle-tasks/initTaskSubmodules.ts | ACTIVE_TASK_INPUT.ts: imports `taskBranchName` from tackle-tasks/createTaskWorktree.ts, `taskFilesProjectRoot` from taskFiles.ts
- Attempts counters read/bumped: none (no getAttemptCount/raiseAttemptCount hits in these box scripts).
- exitType values written: "invalid-number", "blocked", "already-active", "not-resumable", "fence-violation".
- returns_a_prompt: No.

## DOCUMENT_GENERATION
- Mock lines: 248-260
- blockInputFields: `DOCUMENT_GENERATION: ["docsMode"]`
- live comments:
  - `live: steps/pipeline-documentGeneration/WHAT_IS_DOCS_MODE.ts, DOCS_MODE_AUTOGEN.ts, DOCS_MODE_UPDATE.ts`
  - `live: AUTO_GENERATE_DOCS.ts or UPDATE_AUTO_GENERATED_DOCS.ts -> tackle-tasks/writeTaskBrief.ts:writeTaskBriefToDisk, plans/brief-N.md`
- Boxes absorbed (pipeline-documentGeneration.mmd, per steps.json / dir listing): WORKTREE_DOCS_MODE_INPUT, WHAT_IS_DOCS_MODE, DOCS_MODE_AUTOGEN, DOCS_MODE_UPDATE, AUTO_GENERATE_DOCS, UPDATE_AUTO_GENERATED_DOCS, PLAN_PIPELINE (local re-export).
- Decisions / next:
  - docsMode not "AUTOGEN" and not "UPDATE" -> throws Error (defensive, no next)
  - otherwise -> `next: PLAN_THE_TASK` (unconditional)
- Real helper functions:
  AUTO_GENERATE_DOCS.ts: imports `configureGeneratedArtifactIsolation, writeTaskBriefToDisk` from tackle-tasks/writeTaskBrief.ts | UPDATE_AUTO_GENERATED_DOCS.ts: imports `configureGeneratedArtifactIsolation, writeTaskBriefToDisk` from tackle-tasks/writeTaskBrief.ts | WHAT_IS_DOCS_MODE.ts, DOCS_MODE_AUTOGEN.ts, DOCS_MODE_UPDATE.ts, WORKTREE_DOCS_MODE_INPUT.ts, PLAN_PIPELINE.ts: no tackle-tasks/*.ts helper calls (routing-only boxes).
- Attempts counters: none. exitType writes: none.
- returns_a_prompt: No.

## REPORT_ONLY_EXIT
- Mock lines: 130-134 (helper `reportExitTypeAndStop`), block body 264-266
- blockInputFields: `REPORT_ONLY_EXIT: ["taskNumber", "exitType", "exitNote"]`
- live comments: header comment line 130: `pipeline-reportOnlyExit.mmd as one function. Writes nothing. live: steps/pipeline-reportOnlyExit/REPORT_EXIT_TYPE_NO_WRITE.ts, then STOP.ts`
- Boxes absorbed (pipeline-reportOnlyExit.mmd): EXIT_TYPE_NOTE_NO_WRITE_INPUT, REPORT_EXIT_TYPE_NO_WRITE, STOP.
- Decisions / next: always `next: null` (terminal). No conditions.
- Real helper functions: none — REPORT_EXIT_TYPE_NO_WRITE.ts and STOP.ts import only `SCRIPT_SIGNAL` from contracts.ts (no tackle-tasks/*.ts calls; pure reporting, matches boxesToSourceMap.md "Needs no script").
- Attempts counters: none. exitType writes: none (reads input.exitType/exitNote, writes nothing to disk).
- returns_a_prompt: No.

## FAILURES_EXIT
- Mock lines: 84-128 (helper `reportRunsExitType`), block body 270-272
- blockInputFields: `FAILURES_EXIT: ["task", "runId", "exitType", "exitNote"]`
- live comments (verbatim, in order):
  `live: steps/pipeline-failuresExit/READ_FAILURES_PUBLICATION_STATE.ts -> tackle-tasks/readPublicationState.ts` | `live: DID_ANY_WORK_LAND.ts, then WRITE_PUBLICATION_OUTCOME.ts or WRITE_EXIT_TYPE_AND_NOTE.ts -> tackle-tasks/writeTaskExitNotes.ts` | `live: RECORD_MODIFIED_FILES_FAILURE.ts -> tackle-tasks/recordTaskModifiedFiles.ts` | `live: MARK_TASK_INACTIVE_FAILURE.ts -> tackle-tasks/markTaskInactive.ts` | `live: DOES_RUN_HOLD_LEASE.ts and RELEASE_WORKTREE_LEASE.ts -> prepareTasks.ts:releaseTaskWorktreeLease` | `live: DOES_RUN_HOLD_SOURCE_LOCK.ts and RELEASE_SOURCE_LOCK.ts -> tackle-tasks/sourceRepoLock.ts:releaseSourceRepoLock` | `live: REPORT_EXIT_TYPE_AND_NOTE.ts, then STOP.ts`
- Boxes absorbed (pipeline-failuresExit.mmd, all 14): READ_FAILURES_PUBLICATION_STATE, DID_ANY_WORK_LAND, WRITE_PUBLICATION_OUTCOME, WRITE_EXIT_TYPE_AND_NOTE, RECORD_MODIFIED_FILES_FAILURE, MARK_TASK_INACTIVE_FAILURE, DOES_RUN_HOLD_LEASE, RELEASE_WORKTREE_LEASE, DOES_RUN_HOLD_SOURCE_LOCK, RELEASE_SOURCE_LOCK, EXIT_TYPE_NOTE_INPUT, REPORT_EXIT_TYPE_AND_NOTE, STOP.
- Decisions / next: always `next: null` (terminal); internal branches (not routing):
  publicationState !== "NONE LANDED" -> exitType kept "completed" else set "partially-published"; else write input.exitType verbatim | run.leaseRunId === input.runId -> release lease (else no-op) | run.sourceLockOwner === `${runId}:${taskNumber}` -> release lock (else no-op)
- Real helper functions:
  READ_FAILURES_PUBLICATION_STATE.ts: `readPublicationState` from tackle-tasks/readPublicationState.ts | WRITE_PUBLICATION_OUTCOME.ts: `writeTaskExitNotes` from tackle-tasks/writeTaskExitNotes.ts, `getCurrentTaskRun, updateCurrentTaskRun` from tackle-tasks/taskRunState.ts | WRITE_EXIT_TYPE_AND_NOTE.ts: `writeTaskExitNotes` from tackle-tasks/writeTaskExitNotes.ts | RECORD_MODIFIED_FILES_FAILURE.ts: `recordTaskModifiedFiles` from tackle-tasks/recordTaskModifiedFiles.ts | MARK_TASK_INACTIVE_FAILURE.ts: `markTaskInactive` from tackle-tasks/markTaskInactive.ts | DOES_RUN_HOLD_LEASE.ts: `readTaskWorktreeLeaseOwner, taskWorktreeLeasePath` from prepareTasks.ts | RELEASE_WORKTREE_LEASE.ts: `releaseTaskWorktreeLease` from prepareTasks.ts, `taskBranchName` from tackle-tasks/createTaskWorktree.ts | DOES_RUN_HOLD_SOURCE_LOCK.ts: `buildLockOwner, readSourceRepoLock` from tackle-tasks/sourceRepoLock.ts | RELEASE_SOURCE_LOCK.ts: `buildLockOwner, releaseSourceRepoLock` from tackle-tasks/sourceRepoLock.ts | DID_ANY_WORK_LAND.ts, EXIT_TYPE_NOTE_INPUT.ts, REPORT_EXIT_TYPE_AND_NOTE.ts, STOP.ts: routing-only, no tackle-tasks helper.
- Attempts counters: none. exitType values written: "partially-published" or verbatim caller-supplied exitType (e.g. "clarify-stuck", "not-resumable", "tests-red", etc. — whichever the caller passed in).
- returns_a_prompt: No.

## PLAN_THE_TASK
- Mock lines: 277-290
- blockInputFields: `PLAN_THE_TASK: ["task", "codexNotes"]`
- live comments: `// Prompt block. live: steps/pipeline-plan/PLAN_THE_TASK.ts -> tackle-tasks/planPrompt.ts:planPrompt` (line 276)
- Boxes absorbed: pipeline-plan.mmd box PLAN_THE_TASK only (this monolith block corresponds to just that one box within the plan-pipeline group; WHAT_DID_THE_PLANNER_RETURN is the sibling monolith block covering the rest of pipeline-plan.mmd).
- Decisions / next: always `next: WHAT_DID_THE_PLANNER_RETURN` (prompt block; no branching, only appends codexNotes text if present).
- Real helper functions: PLAN_THE_TASK.ts imports `loadPreparedTask` from tackle-tasks/preparedTask.ts, `planPrompt` from tackle-tasks/planPrompt.ts.
- Attempts counters: none directly (consumed by sibling block). exitType writes: none.
- returns_a_prompt: **Yes**. Current script builds the prompt itself via `planPrompt` (tackle-tasks/planPrompt.ts), not an "Emitter" class. Header comment at scripts/steps/pipeline-plan/PLAN_THE_TASK.ts:1 says: "builds the planner agent's prompt from PlannerBodyEmitter.ts's old planPrompt()" — i.e. its ancestor was PlannerBodyEmitter.ts, current call site is scripts/tackle-tasks/planPrompt.ts:planPrompt (steps/pipeline-plan/PLAN_THE_TASK.ts:1, import line ~7-8).

## WHAT_DID_THE_PLANNER_RETURN
- Mock lines: 293-329
- blockInputFields: `WHAT_DID_THE_PLANNER_RETURN: ["task", "answer"]`
- live comments (verbatim, in order):
  `live: PLANNER_RETURNED_PLAN.ts, then REVIEW_PLAN_PIPELINE.ts` | `live: PLANNER_RETURNED_CLARIFY.ts; the planner agent words clarifyRequest itself` | `live: ARE_2_CLARIFY_ROUNDS_DONE.ts -> taskRunState.ts:getAttemptCount, MAX_ATTEMPTS` | `live: WRITE_CLARIFY_REQUEST.ts + taskRunState.ts:raiseAttemptCount, then DOCUMENT_GENERATION_PIPELINE.ts`
- Boxes absorbed (rest of pipeline-plan.mmd): WHAT_DID_THE_PLANNER_RETURN, PLANNER_RETURNED_PLAN, PLANNER_RETURNED_CLARIFY, ARE_2_CLARIFY_ROUNDS_DONE, WRITE_CLARIFY_REQUEST, EXIT_WORKFLOW_PLAN, REVIEW_PLAN_PIPELINE, DOCS_INPUT, DOCUMENT_GENERATION_PIPELINE.
- Decisions / next:
  answer === "PLAN" -> `next: CODEX_REVIEWS_PLAN` | answer === "CLARIFY" and clarify attempts >= 2 -> `next: FAILURES_EXIT`, exitType "clarify-stuck" | answer === "CLARIFY" and attempts < 2 -> `next: DOCUMENT_GENERATION`, docsMode "UPDATE" (bumps clarify counter) | any other answer -> throws Error
- Real helper functions:
  ARE_2_CLARIFY_ROUNDS_DONE.ts: `getAttemptCount, MAX_ATTEMPTS` from tackle-tasks/taskRunState.ts | WRITE_CLARIFY_REQUEST.ts: `readTaskFile, resolveTaskFiles` from taskFiles.ts, `requireAbsolutePath` from tackle-tasks/inputPaths.ts, `withTaskStateLock, writeJsonAtomically` from taskStateLock.ts, `raiseAttemptCount` from tackle-tasks/taskRunState.ts (ported from tackle-tasks/writeClarifyRequest.ts per its header comment) | PLANNER_RETURNED_PLAN.ts, PLANNER_RETURNED_CLARIFY.ts, EXIT_WORKFLOW_PLAN.ts, REVIEW_PLAN_PIPELINE.ts, DOCS_INPUT.ts, DOCUMENT_GENERATION_PIPELINE.ts: routing-only, no helper calls.
- Attempts counter: `"clarify"` (getAttemptCount / raiseAttemptCount via tackle-tasks/taskRunState.ts, MAX_ATTEMPTS=2). exitType written: "clarify-stuck".
- returns_a_prompt: No.

## CODEX_REVIEWS_PLAN
- Mock lines: 334-349
- blockInputFields: `CODEX_REVIEWS_PLAN: ["task"]`
- live comments: `// Prompt block. live: steps/pipeline-reviewPlan/CODEX_REVIEWS_PLAN.ts + tackle-tasks/planArtifacts.ts:readAndValidatePlan` (line 333); inline comment line 342: `// live: codex exec, else claude -p fable, else claude -p opus. Three-way fallback in CODEX_REVIEWS_PLAN.ts`
- Boxes absorbed: pipeline-reviewPlan.mmd box CODEX_REVIEWS_PLAN (its sibling WHAT_IS_REVIEW_VERDICT covers the rest of that diagram).
- Decisions / next: always `next: WHAT_IS_REVIEW_VERDICT` (prompt block, no branching).
- Real helper functions: CODEX_REVIEWS_PLAN.ts imports `reviewQuestion` from tackle-tasks/CodexReviewBodyEmitter.ts, `loadPreparedTask` from tackle-tasks/preparedTask.ts. (mock names planArtifacts.ts:readAndValidatePlan; not actually imported — box header says "Ported from CodexReviewBodyEmitter.ts".)
- Attempts counters: none. exitType writes: none.
- returns_a_prompt: **Yes**. Emitter: CodexReviewBodyEmitter.ts, function `reviewQuestion`, imported at scripts/steps/pipeline-reviewPlan/CODEX_REVIEWS_PLAN.ts:9 (`import { reviewQuestion } from "../../tackle-tasks/CodexReviewBodyEmitter.ts";`).

## WHAT_IS_REVIEW_VERDICT
- Mock lines: 352-423
- blockInputFields: `WHAT_IS_REVIEW_VERDICT: ["task", "answer"]`
- live comments (verbatim, in order):
  `live: planReviewRuling.ts:rulingByFixCount, or rulingByPercentage at 12+ sections` | `live: VERDICT_ERROR.ts carries packet.notes as the exit note` | `live: VERDICT_ACCEPT.ts, then IMPLEMENT_PIPELINE.ts` | `live: VERDICT_AMEND_THEN_ACCEPT.ts:applyFixesToPlan writes the fixes into the plan` | `live: VERDICT_AMEND.ts or VERDICT_SCRAP.ts, then UPDATE_TASK_ENTRY.ts:writeCodexReviewNotes` | `live: ARE_2_REVIEWS_DONE.ts, REVIEWS_LIMIT = 2, then PLAN_PIPELINE.ts`
- Boxes absorbed (rest of pipeline-reviewPlan.mmd): WHAT_IS_REVIEW_VERDICT, VERDICT_ACCEPT, VERDICT_AMEND_THEN_ACCEPT, VERDICT_AMEND, VERDICT_SCRAP, VERDICT_ERROR, UPDATE_TASK_ENTRY, ARE_2_REVIEWS_DONE, EXIT_WORKFLOW_REVIEW_PLAN, IMPLEMENT_PIPELINE, DRAFT_PLAN_INPUT, PLAN_PIPELINE.
- Decisions / next:
  review.outcome === "ERROR" -> verdict "ERROR" -> `next: FAILURES_EXIT`, exitType "run-failed" | else compute verdict from fixCount/sectionCount (ACCEPT / AMEND_THEN_ACCEPT / AMEND / SCRAP) via sectionCount>=12 percentage rule or small-plan fixCount rule | verdict "ACCEPT" or "AMEND_THEN_ACCEPT" -> `next: IMPLEMENT_TASK` | verdict "AMEND"/"SCRAP" and reviewCount(after increment) >= 2 -> `next: FAILURES_EXIT`, exitType "plan-scrapped" | verdict "AMEND"/"SCRAP" and reviewCount < 2 -> `next: PLAN_THE_TASK` with codexNotes
- Real helper functions:
  WHAT_IS_REVIEW_VERDICT.ts: `efficacyPercentage, Ruling, rulingByFixCount, rulingByPercentage` from planReviewRuling.ts; `type PlanReview` from tackle-tasks/recordPlanReview.ts | VERDICT_AMEND_THEN_ACCEPT.ts: `writeJsonAtomically` from taskStateLock.ts; `type PlanReview` from tackle-tasks/recordPlanReview.ts | UPDATE_TASK_ENTRY.ts: `readTaskFile, resolveTaskFiles` from taskFiles.ts, `withTaskStateLock, writeJsonAtomically` from taskStateLock.ts (also served by tackle-tasks/recordPlanReview.ts per boxesToSourceMap.md) | DRAFT_PLAN_INPUT.ts: `requireAbsolutePath` from tackle-tasks/inputPaths.ts, `loadPreparedTask` from tackle-tasks/preparedTask.ts | VERDICT_ACCEPT.ts, VERDICT_AMEND.ts, VERDICT_SCRAP.ts, VERDICT_ERROR.ts, ARE_2_REVIEWS_DONE.ts, EXIT_WORKFLOW_REVIEW_PLAN.ts, IMPLEMENT_PIPELINE.ts, PLAN_PIPELINE.ts: routing-only, no tackle-tasks helper import.
- Attempts counter: plan review count is **payload-only** (`reviewCount` field on the packet, not a taskRunState counter — confirmed in ARE_2_REVIEWS_DONE.ts, REVIEWS_LIMIT=2 local const, no getAttemptCount/raiseAttemptCount import). exitType written: "run-failed", "plan-scrapped".
- returns_a_prompt: No.

## IMPLEMENT_TASK
- Mock lines: 428-439
- blockInputFields: `IMPLEMENT_TASK: ["task"]`
- live comments: `// Prompt block. live: steps/pipeline-implement/IMPLEMENT_TASK.ts:buildImplementPrompt -> tackle-tasks/preparedTask.ts:loadPreparedTask` (line 427)
- Boxes absorbed: pipeline-implement.mmd box IMPLEMENT_TASK only (sibling COMMIT_IMPLEMENTATION_IF_NEEDED covers the rest of implement + all of taskTests).
- Decisions / next: always `next: COMMIT_IMPLEMENTATION_IF_NEEDED` (prompt block; appends codexReviewNotes text if present).
- Real helper functions: IMPLEMENT_TASK.ts imports `loadPreparedTask, type PreparedTask` from tackle-tasks/preparedTask.ts, `absolutePathsSection` from tackle-tasks/promptSections.ts; builds its own prompt text in-file via local `buildImplementPrompt` (does NOT import ImplementBodyEmitter.ts — see below).
- Attempts counters: none. exitType writes: none.
- returns_a_prompt: **Yes**. Header comment (scripts/steps/pipeline-implement/IMPLEMENT_TASK.ts:1): "COMMIT_IMPLEMENTATION_IF_NEEDED now owns committing, not this box." The prompt body is built in-file (function `buildImplementPrompt`, IMPLEMENT_TASK.ts) — it does not call ImplementBodyEmitter.ts at all; boxesToSourceMap.md lists `implement` role -> ImplementBodyEmitter.ts as the historical emitter/contract, but the current box script does not import it.

## COMMIT_IMPLEMENTATION_IF_NEEDED
- Mock lines: 442-492
- blockInputFields: `COMMIT_IMPLEMENTATION_IF_NEEDED: ["task"]`
- live comments (verbatim, in order):
  `live: COMMIT_IMPLEMENTATION_IF_NEEDED.ts -> tackle-tasks/commitTaskWork.ts:commitTaskWork` | `live: steps/pipeline-taskTests/ARE_TASK_TESTS_SKIPPED.ts -> taskFiles.ts:taskHasTests` | `live: steps/pipeline-taskTests/RUN_TASK_TESTS.ts -> tackle-tasks/runTaskTestsImpl.ts:runTaskTests` | `live: DO_TASK_TESTS_PASS.ts, then REVIEW_TESTS_PIPELINE.ts` | `live: ARE_2_TEST_FIXES_DONE.ts -> taskRunState.ts:getAttemptCount, MAX_ATTEMPTS` | `live: AMEND_ENTRY_WITH_FAILING_TESTS.ts -> amendEntryWithFailingTestsImpl.ts + taskRunState.ts:raiseAttemptCount`
- Boxes absorbed: rest of pipeline-implement.mmd (COMMIT_IMPLEMENTATION_IF_NEEDED, EXIT_WORKFLOW_IMPLEMENT, TASK_TESTS_PIPELINE, ACCEPTED_PLAN_INPUT) + all of pipeline-taskTests.mmd (ARE_TASK_TESTS_SKIPPED, RUN_TASK_TESTS, DO_TASK_TESTS_PASS, ARE_2_TEST_FIXES_DONE, AMEND_ENTRY_WITH_FAILING_TESTS, EXIT_WORKFLOW_TASK_TESTS, REVIEW_TESTS_PIPELINE, COMMITTED_WORK_INPUT, IMPLEMENT_PIPELINE, REBASE_PREAMBLE_PIPELINE, packet.ts helper).
- Decisions / next:
  !task.hasTests -> `next: LOCK_SOURCE_REPO` (tests skipped) | hasTests, tests pass -> `next: CODEX_REVIEWS_TESTS` | hasTests, tests fail and testFixes attempts >= 2 -> `next: FAILURES_EXIT`, exitType "tests-red" | hasTests, tests fail and attempts < 2 -> `next: IMPLEMENT_TASK` (bump testFixes, amend entry)
- Real helper functions:
  COMMIT_IMPLEMENTATION_IF_NEEDED.ts (pipeline-implement dir): `commitTaskWork` from tackle-tasks/commitTaskWork.ts | ARE_TASK_TESTS_SKIPPED.ts: `readTaskFile, resolveTaskFiles, taskHasTests` from taskFiles.ts; `readPacket` from ./packet.ts | RUN_TASK_TESTS.ts: `runTaskTests` from tackle-tasks/runTaskTestsImpl.ts; `readPacket` from ./packet.ts | AMEND_ENTRY_WITH_FAILING_TESTS.ts: `amendEntryWithFailingTests` from tackle-tasks/amendEntryWithFailingTestsImpl.ts, `raiseAttemptCount` from tackle-tasks/taskRunState.ts | ARE_2_TEST_FIXES_DONE.ts: `getAttemptCount, MAX_ATTEMPTS` from tackle-tasks/taskRunState.ts (local const `TEST_FIXES_COUNTER = "testFixes"`) | DO_TASK_TESTS_PASS.ts, COMMITTED_WORK_INPUT.ts, IMPLEMENT_PIPELINE.ts, REBASE_PREAMBLE_PIPELINE.ts, REVIEW_TESTS_PIPELINE.ts, EXIT_WORKFLOW_TASK_TESTS.ts, EXIT_WORKFLOW_IMPLEMENT.ts, TASK_TESTS_PIPELINE.ts, ACCEPTED_PLAN_INPUT.ts: routing/packet-only (ACCEPTED_PLAN_INPUT.ts imports `requireAbsolutePath` from tackle-tasks/inputPaths.ts).
- Attempts counter: `"testFixes"` (getAttemptCount / raiseAttemptCount, MAX_ATTEMPTS=2). exitType written: "tests-red".
- returns_a_prompt: No.

## CODEX_REVIEWS_TESTS
- Mock lines: 497-506
- blockInputFields: `CODEX_REVIEWS_TESTS: ["task"]`
- live comments: `// Prompt block. live: steps/pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts; its shell command ends in decideTestReview.ts` (line 496)
- Boxes absorbed: pipeline-reviewTests.mmd box CODEX_REVIEWS_TESTS only (sibling ARE_TESTS_FLAGGED covers the rest).
- Decisions / next: always `next: ARE_TESTS_FLAGGED` (prompt block).
- Real helper functions: CODEX_REVIEWS_TESTS.ts imports `loadPreparedTask` from tackle-tasks/preparedTask.ts, `getCurrentTaskRun` from tackle-tasks/taskRunState.ts, `reviewTestsQuestion` from tackle-tasks/CodexTestReviewBodyEmitter.ts (mock's decideTestReview.ts is NOT imported — listed in boxesToSourceMap.md as "nothing calls").
- Attempts counters: none. exitType writes: none.
- returns_a_prompt: **Yes**. Emitter: CodexTestReviewBodyEmitter.ts, function `reviewTestsQuestion`, imported at scripts/steps/pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts:10 (`import { reviewTestsQuestion } from "../../tackle-tasks/CodexTestReviewBodyEmitter.ts";`). Header line 1: "Ported from scripts/tackle-tasks/CodexTestReviewBodyEmitter.ts."

## ARE_TESTS_FLAGGED
- Mock lines: 509-534
- blockInputFields: `ARE_TESTS_FLAGGED: ["task", "answer"]`
- live comments (verbatim, in order):
  `live: ARE_TESTS_FLAGGED.ts routes on flagged` | `live: ARE_2_TEST_REVIEWS_DONE.ts still reads the shared codexReviewNotes field` | `live: AMEND_ENTRY_WITH_CODEX_NOTES.ts, then IMPLEMENT_PIPELINE.ts`
- Boxes absorbed (rest of pipeline-reviewTests.mmd): ARE_TESTS_FLAGGED, ARE_2_TEST_REVIEWS_DONE, AMEND_ENTRY_WITH_CODEX_NOTES, EXIT_WORKFLOW_REVIEW_TESTS, GREEN_IMPLEMENTATION_INPUT, REBASE_PREAMBLE_PIPELINE, IMPLEMENT_PIPELINE.
- Decisions / next:
  review.flagged === true and (testReviews after increment) >= 2 -> `next: FAILURES_EXIT`, exitType "tests-flagged" | review.flagged === true, attempts < 2 -> `next: IMPLEMENT_TASK` (amend entry with codex notes) | review.flagged !== true -> `next: LOCK_SOURCE_REPO`
- Real helper functions:
  AMEND_ENTRY_WITH_CODEX_NOTES.ts: `readTaskFile, resolveTaskFiles` from taskFiles.ts, `withTaskStateLock, writeJsonAtomically` from taskStateLock.ts | ARE_2_TEST_REVIEWS_DONE.ts: `readTaskFile, resolveTaskFiles` from taskFiles.ts — **note: this box does NOT call taskRunState.ts's getAttemptCount/raiseAttemptCount.** It decides "reviewsDone" by checking whether `task.codexReviewNotes` is already a non-empty string (function `hasAlreadyBeenAmended`), i.e. it re-reads tasks.json directly rather than using a persisted attempt counter. | GREEN_IMPLEMENTATION_INPUT.ts: `requireAbsolutePath` from tackle-tasks/inputPaths.ts | ARE_TESTS_FLAGGED.ts, EXIT_WORKFLOW_REVIEW_TESTS.ts, REBASE_PREAMBLE_PIPELINE.ts, IMPLEMENT_PIPELINE.ts: routing-only.
- Attempts counter: **none via taskRunState.ts** — the mock's `attempts.testReviews` counter has no live equivalent; the real box (ARE_2_TEST_REVIEWS_DONE.ts) instead reads task.codexReviewNotes non-emptiness from tasks.json. exitType written: "tests-flagged".
- returns_a_prompt: No.

## LOCK_SOURCE_REPO
- Mock lines: 539-567
- blockInputFields: `LOCK_SOURCE_REPO: ["task", "runId"]`
- live comments (verbatim, in order):
  `live: steps/pipeline-rebasePreamble/LOCK_SOURCE_REPO.ts -> tackle-tasks/sourceRepoLock.ts:acquireSourceRepoLock` (header, line 538) | `live: WAS_LOCK_ACQUIRED.ts; YES -> steps/pipeline-rebasePreamble/REBASE_PIPELINE.ts sets suiteFixAttempts 0 and stepId "rebase"` | `live: HAVE_15_MINUTES_PASSED.ts reads a wall clock from lockWaitStartedAt` | `live: WAIT_FOR_LOCK.ts sleeps WAIT_FOR_LOCK_MS with Atomics.wait, then LOCK_SOURCE_REPO.ts again`
- Boxes absorbed (pipeline-rebasePreamble.mmd, all): LOCK_SOURCE_REPO, WAS_LOCK_ACQUIRED, HAVE_15_MINUTES_PASSED, WAIT_FOR_LOCK, FINISHED_IMPLEMENTATION_INPUT, EXIT_WORKFLOW_REBASE_PREAMBLE, REBASE_PIPELINE.
- Decisions / next (looped in the mock via `while(true)`, one persisted call per hook cycle in reality):
  lock acquired -> `next: REBASE_ONTO_TARGET_BRANCH`, suiteFixAttempts reset to 0 | not acquired, waited >= 15 min -> `next: FAILURES_EXIT`, exitType "run-failed" | not acquired, < 15 min -> loop/wait 5s and retry (in the real hook: WAIT_FOR_LOCK.ts sleeps then re-enters LOCK_SOURCE_REPO.ts)
- Real helper functions: LOCK_SOURCE_REPO.ts imports `requireAbsolutePath` from tackle-tasks/inputPaths.ts, `acquireSourceRepoLock, buildLockOwner` from tackle-tasks/sourceRepoLock.ts. WAS_LOCK_ACQUIRED.ts, HAVE_15_MINUTES_PASSED.ts, WAIT_FOR_LOCK.ts, REBASE_PIPELINE.ts, FINISHED_IMPLEMENTATION_INPUT.ts, EXIT_WORKFLOW_REBASE_PREAMBLE.ts: no tackle-tasks helper imports (routing-only; per boxesToSourceMap.md caveat, the actually-enforced bounded-poll lock, `acquireSourceRepoLockBounded`, lives in tackle-tasks/rebaseTaskWorktree.ts, not here — a discrepancy the doc flags as stale-worth-rechecking).
- Attempts counters: none (15-minute wait is a wall-clock check, not an attempt counter). exitType written: "run-failed".
- returns_a_prompt: No.

## REBASE_ONTO_TARGET_BRANCH
- Mock lines: 572-598
- blockInputFields: `REBASE_ONTO_TARGET_BRANCH: ["task"]`
- live comments (verbatim, in order):
  `live: steps/pipeline-rebase/REBASE_ONTO_TARGET_BRANCH.ts -> rebaseTaskWorktree.ts` (header, line 571) | `live: DID_REBASE_REPORT_CONFLICTS.ts routes on conflicted only` | `live: rebaseTaskWorktree.ts:persistSourceTipReceipts, inside the rebase box itself` | `live: ARE_2_CONFLICT_FIXES_DONE.ts -> taskRunState.ts:getAttemptCount, raiseAttemptCount`
- Boxes absorbed: pipeline-rebase.mmd boxes REBASE_ONTO_TARGET_BRANCH, DID_REBASE_REPORT_CONFLICTS, ARE_2_CONFLICT_FIXES_DONE, SOURCE_REPO_LOCKED_INPUT, SUITE_PIPELINE, packet.ts. (sibling monolith blocks FIX_CONFLICTS / COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED cover the rest of pipeline-rebase.mmd.)
- Decisions / next:
  no conflicts -> `next: RUN_FULL_SUITE` | conflicts, attempts (after increment) >= 2 -> `next: FAILURES_EXIT`, exitType "rebase-stuck" | conflicts, attempts < 2 -> `next: FIX_CONFLICTS`
- Real helper functions:
  REBASE_ONTO_TARGET_BRANCH.ts: `rebaseTaskWorktree` from tackle-tasks/rebaseTaskWorktree.ts | ARE_2_CONFLICT_FIXES_DONE.ts: `getAttemptCount, raiseAttemptCount, MAX_ATTEMPTS` from tackle-tasks/taskRunState.ts (local const `CONFLICT_FIX_COUNTER = "pipeline-rebase-conflict-fix"`); also imports `refreshLockHeartbeat` from ./packet.ts | packet.ts (pipeline-rebase): `buildLockOwner, refreshOwnedSourceRepoLockOrThrow` from tackle-tasks/sourceRepoLock.ts | DID_REBASE_REPORT_CONFLICTS.ts, SOURCE_REPO_LOCKED_INPUT.ts, SUITE_PIPELINE.ts: routing-only.
- Attempts counter: `"pipeline-rebase-conflict-fix"` (getAttemptCount/raiseAttemptCount, MAX_ATTEMPTS=2). exitType written: "rebase-stuck".
- returns_a_prompt: No.

## FIX_CONFLICTS
- Mock lines: 601-608
- blockInputFields: `FIX_CONFLICTS: ["task"]`
- live comments: `// Prompt block. live: steps/pipeline-rebase/FIX_CONFLICTS.ts -> tackle-tasks/FixConflictsBodyEmitter.ts:fixConflictsPrompt` (line 600)
- Boxes absorbed: pipeline-rebase.mmd box FIX_CONFLICTS only.
- Decisions / next: always `next: COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED` (prompt block).
- Real helper functions: FIX_CONFLICTS.ts imports `fixConflictsPrompt` from tackle-tasks/FixConflictsBodyEmitter.ts, `refreshLockHeartbeat, type RebasePacket` from ./packet.ts.
- Attempts counters: none. exitType writes: none.
- returns_a_prompt: **Yes**. Emitter: FixConflictsBodyEmitter.ts, function `fixConflictsPrompt`, imported at scripts/steps/pipeline-rebase/FIX_CONFLICTS.ts:7 (`import { fixConflictsPrompt } from "../../tackle-tasks/FixConflictsBodyEmitter.ts";`). Header line 1: "Reuses fixConflictsPrompt, the sole home of this prompt's text."

## COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED
- Mock lines: 611-649
- blockInputFields: `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: ["task"]`
- live comments (verbatim, in order):
  `live: COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts -> tackle-tasks/commitTaskWork.ts:commitTaskWork` | `live: CONTINUE_REBASE.ts -> tackle-tasks/advanceTaskRebase.ts:advanceTaskRebase` | `live: IS_REBASE_FINISHED.ts, then SUITE_PIPELINE.ts` | `live: advanceTaskRebase.ts calls rebaseTaskWorktree.ts:persistSourceTipReceipts` | `live: DID_REBASE_REPORT_CONFLICTS.ts, then ARE_2_CONFLICT_FIXES_DONE.ts again`
- Boxes absorbed: pipeline-rebase.mmd boxes COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED, CONTINUE_REBASE, IS_REBASE_FINISHED, EXIT_WORKFLOW_REBASE (plus re-uses DID_REBASE_REPORT_CONFLICTS/ARE_2_CONFLICT_FIXES_DONE logic already counted under REBASE_ONTO_TARGET_BRANCH).
- Decisions / next:
  rebase finished -> `next: RUN_FULL_SUITE` | not finished (stopped on new conflicts), attempts >= 2 -> `next: FAILURES_EXIT`, exitType "rebase-stuck" | not finished, attempts < 2 -> `next: FIX_CONFLICTS`
- Real helper functions:
  COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts: `commitTaskWork` from tackle-tasks/commitTaskWork.ts, `refreshLockHeartbeat, type RebasePacket` from ./packet.ts | CONTINUE_REBASE.ts: `advanceTaskRebase` from tackle-tasks/advanceTaskRebase.ts | IS_REBASE_FINISHED.ts, EXIT_WORKFLOW_REBASE.ts: routing-only.
- Attempts counter: same `"pipeline-rebase-conflict-fix"` counter as REBASE_ONTO_TARGET_BRANCH (shared via ARE_2_CONFLICT_FIXES_DONE.ts). exitType written: "rebase-stuck".
- returns_a_prompt: No.

## RUN_FULL_SUITE
- Mock lines: 654-795
- blockInputFields: `RUN_FULL_SUITE: ["task", "tasks", "suiteFixAttempts"]`
- live comments (verbatim, in order):
  `live: steps/pipeline-suite/COMMIT_SUITE_FIX_IF_NEEDED.ts -> tackle-tasks/commitTaskWork.ts` | `live: RUN_FULL_SUITE.ts -> tackle-tasks/runFullSuite.ts:runFullSuite; input from REBASED_WORKTREE_INPUT.ts` | `live: DO_ALL_TESTS_PASS.ts` | `live: ARE_2_SUITE_FIXES_DONE.ts, MAX_SUITE_FIX_ATTEMPTS = 2, payload-only counter` | `live: DID_CHANGES_STAY_INSIDE_FENCE.ts -> tackle-tasks/checkTaskFileFence.ts:checkTaskFileFence` | `live: steps/pipeline-merge/MERGE_WORKTREES.ts -> tackle-tasks/mergeTaskWorktree.ts -> mergeTaskWorktrees.ts` | `live: READ_MERGE_PUBLICATION_STATE.ts -> tackle-tasks/readPublicationState.ts` | `live: WHAT_IS_PUBLICATION_STATE.ts; not ALL or NONE routes to PUBLICATION_PARTIAL.ts` | `live: PUBLICATION_NONE.ts, then ARE_2_MERGE_ATTEMPTS_DONE.ts -> taskRunState.ts:raiseAttemptCount("merge")` | `live: steps/pipeline-merge/REBASE_PIPELINE.ts forwards suiteFixAttempts and landedOccurrenceIds unchanged` | `live: MERGE_RECEIPT_INPUT.ts re-reads the publication state and refuses to archive unless ALL LANDED` | `live: steps/pipeline-mergeSucceededExit/RECORD_MERGE_COMMIT_HASHES.ts -> recordMergeCommits.ts, one per landed layer` | `live: WRITE_EXIT_TYPE_COMPLETED.ts -> tackle-tasks/writeTaskExitNotes.ts; the point of no return` | `live: RECORD_MODIFIED_FILES_SUCCESS.ts -> tackle-tasks/recordTaskModifiedFiles.ts` | `live: CLEAN_UP_WORKTREES.ts -> tackle-tasks/cleanupTaskWorktree.ts:cleanupTaskWorktree` | `live: BUILD_CLOSURE_NOTE.ts -> tackle-tasks/buildClosureNote.ts:buildClosureNote` | `live: MARK_TASK_INACTIVE_SUCCESS.ts -> tackle-tasks/markTaskInactive.ts` | `live: ARCHIVE_TASK.ts -> tackle-tasks/closeTaskRun.ts -> closeTasks.ts:closeTaskRunReconciled` | `live: REPORT_CLOSURE_NOTE.ts, then STOP.ts`
- Boxes absorbed: pipeline-suite.mmd (minus FIX_THE_CODEBASE_FOR_SUITE) — COMMIT_SUITE_FIX_IF_NEEDED, RUN_FULL_SUITE, DO_ALL_TESTS_PASS, ARE_2_SUITE_FIXES_DONE, DID_CHANGES_STAY_INSIDE_FENCE, EXIT_WORKFLOW_SUITE, MERGE_PIPELINE, REBASED_WORKTREE_INPUT — plus all of pipeline-merge.mmd — MERGE_WORKTREES, READ_MERGE_PUBLICATION_STATE, WHAT_IS_PUBLICATION_STATE, PUBLICATION_ALL, PUBLICATION_NONE, PUBLICATION_PARTIAL, ARE_2_MERGE_ATTEMPTS_DONE, REBASE_PIPELINE, GREEN_WORKTREE_INPUT, EXIT_WORKFLOW_MERGE, EXIT_WORKFLOW_SUCCESS — plus all of pipeline-mergeSucceededExit.mmd — MERGE_RECEIPT_INPUT, RECORD_MERGE_COMMIT_HASHES, WRITE_EXIT_TYPE_COMPLETED, RECORD_MODIFIED_FILES_SUCCESS, CLEAN_UP_WORKTREES, BUILD_CLOSURE_NOTE, MARK_TASK_INACTIVE_SUCCESS, ARCHIVE_TASK, REPORT_CLOSURE_NOTE, STOP.
- Decisions / next:
  suite fails, suiteFixAttempts (payload) >= 2 -> `next: FAILURES_EXIT`, exitType "suite-red" | suite fails, attempts < 2 -> `next: FIX_THE_CODEBASE_FOR_SUITE`, suiteFixAttempts+1 | suite passes, change outside fence -> `next: FAILURES_EXIT`, exitType "fence-violation" | suite passes, inside fence, publicationState "SOME LANDED" -> `next: FAILURES_EXIT`, exitType "partially-published" | "NONE LANDED", merge attempts (after increment) >= 2 -> `next: FAILURES_EXIT`, exitType "merge-failed" | "NONE LANDED", attempts < 2 -> `next: REBASE_ONTO_TARGET_BRANCH` (target moved, retry) | publicationState not "ALL LANDED" and not one of the above -> throws Error | "ALL LANDED" -> writes exitType "completed", archives, `next: null` (terminal)
- Real helper functions:
  RUN_FULL_SUITE.ts (pipeline-suite): `runFullSuite` from tackle-tasks/runFullSuite.ts | COMMIT_SUITE_FIX_IF_NEEDED.ts: `commitTaskWork` from tackle-tasks/commitTaskWork.ts | DID_CHANGES_STAY_INSIDE_FENCE.ts: `checkTaskFileFence` from tackle-tasks/checkTaskFileFence.ts | REBASED_WORKTREE_INPUT.ts: `loadPreparedTask` from tackle-tasks/preparedTask.ts | MERGE_WORKTREES.ts: `mergeTaskWorktree` from tackle-tasks/mergeTaskWorktree.ts | READ_MERGE_PUBLICATION_STATE.ts: `readPublicationState` from tackle-tasks/readPublicationState.ts | ARE_2_MERGE_ATTEMPTS_DONE.ts: `MAX_ATTEMPTS, raiseAttemptCount` from tackle-tasks/taskRunState.ts (counter key `"merge"`) | MERGE_RECEIPT_INPUT.ts: `requireAbsolutePath` from tackle-tasks/inputPaths.ts, `readPublicationState` from tackle-tasks/readPublicationState.ts | RECORD_MERGE_COMMIT_HASHES.ts: `recordMergeCommits` from tackle-tasks/recordMergeCommits.ts, `type TaskCommit` from tackle-tasks/taskRunState.ts | WRITE_EXIT_TYPE_COMPLETED.ts: `writeTaskExitNotes` from tackle-tasks/writeTaskExitNotes.ts | RECORD_MODIFIED_FILES_SUCCESS.ts: `recordTaskModifiedFiles` from tackle-tasks/recordTaskModifiedFiles.ts | CLEAN_UP_WORKTREES.ts: `cleanupTaskWorktree` from tackle-tasks/cleanupTaskWorktree.ts | BUILD_CLOSURE_NOTE.ts: `buildClosureNote` from tackle-tasks/buildClosureNote.ts | MARK_TASK_INACTIVE_SUCCESS.ts: `markTaskInactive` from tackle-tasks/markTaskInactive.ts | ARCHIVE_TASK.ts: `closeTaskRun` from tackle-tasks/closeTaskRun.ts | ARE_2_SUITE_FIXES_DONE.ts, DO_ALL_TESTS_PASS.ts, EXIT_WORKFLOW_SUITE.ts, MERGE_PIPELINE.ts, PUBLICATION_ALL.ts, PUBLICATION_NONE.ts, PUBLICATION_PARTIAL.ts, WHAT_IS_PUBLICATION_STATE.ts, REBASE_PIPELINE.ts (pipeline-merge), GREEN_WORKTREE_INPUT.ts, EXIT_WORKFLOW_MERGE.ts, EXIT_WORKFLOW_SUCCESS.ts, REPORT_CLOSURE_NOTE.ts, STOP.ts (mergeSucceededExit): routing-only.
- Attempts counters: `"merge"` (raiseAttemptCount only — no separate getAttemptCount call; ARE_2_MERGE_ATTEMPTS_DONE.ts raises then compares to MAX_ATTEMPTS in one step). Suite-fix attempts are **payload-only** (`suiteFixAttempts` field on the packet, local const `MAX_SUITE_FIX_ATTEMPTS = 2` in ARE_2_SUITE_FIXES_DONE.ts — no taskRunState import). exitType values written: "suite-red", "fence-violation", "partially-published", "merge-failed", "completed".
- returns_a_prompt: No.

## FIX_THE_CODEBASE_FOR_SUITE
- Mock lines: 798-805
- blockInputFields: `FIX_THE_CODEBASE_FOR_SUITE: ["task"]`
- live comments: `// Prompt block. live: steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.ts + tackle-tasks/promptSections.ts:absolutePathsSection` (line 797)
- Boxes absorbed: pipeline-suite.mmd box FIX_THE_CODEBASE_FOR_SUITE only.
- Decisions / next: always `next: RUN_FULL_SUITE` (prompt block).
- Real helper functions: FIX_THE_CODEBASE_FOR_SUITE.ts imports `buildPromptOutputTemplate` from contracts.ts, `absolutePathsSection` from tackle-tasks/promptSections.ts; builds its own prompt text in-file via local `buildSuiteFixPrompt` (does not import SuiteFixBodyEmitter.ts).
- Attempts counters: none directly (consumed by RUN_FULL_SUITE/ARE_2_SUITE_FIXES_DONE). exitType writes: none.
- returns_a_prompt: **Yes**. Header comment (scripts/steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.ts:1): "Prompt block; old home: SuiteFixBodyEmitter.ts." — i.e. the prompt used to be built by SuiteFixBodyEmitter.ts; the current box script builds it itself (function `buildSuiteFixPrompt`) and does not import that emitter.

---
