# Pipeline script boxes, mapped to their source files

Which `[C]` script boxes in the diagrams already have a working implementation, and which do not.

Measured on 2026-08-18 against `scripts/tackle-tasks/pipelines.ts` and `scripts/tackle-tasks/*.ts`.
Source is the truth; this file goes stale. Re-derive it with the commands in **How to re-check** below.

## Why this matters

`skills/tackle-tasks/tackle-tasks.workflow.js` calls `step()` for every script box. `step()` only
appends a line to the trace and logs it — it runs nothing. So today the workflow **narrates** all 25
script boxes and **performs** none of them. Wiring them up is the work between here and a usable skill.

## Headline

| | Count |
|---|---|
| Script boxes total | 25 |
| Have a working script, tested — wiring only | 17 |
| Have a script with a caveat | 3 |
| Need no script (reporting or terminal) | 3 |
| **No implementation anywhere** | **2** |

Only two capabilities are genuinely missing: **reading the publication state** and **writing the
clarify request**. Everything else already exists and is tested; it is simply not called.

## Ready — script exists, has a CLI, has tests

Each script's own first line names the diagram box it serves, which is how these were matched.

| Box id | Diagram label | Source file |
|---|---|---|
| `AMEND_ENTRY_WITH_CODEX_NOTES` | amend tasks.json entry with codex's notes and fixes | `scripts/tackle-tasks/amendEntryWithCodexNotes.ts` |
| `AMEND_ENTRY_WITH_FAILING_TESTS` | amend tasks.json entry with the failing tests | `scripts/tackle-tasks/amendEntryWithFailingTests.ts` |
| `ARCHIVE_TASK` | move task to completedTasks.json and update tasks blocked by it | `scripts/tackle-tasks/closeTaskRun.ts` |
| `BUILD_CLOSURE_NOTE` | build the closure note from the recorded run | `scripts/tackle-tasks/buildClosureNote.ts` |
| `CLEAN_UP_WORKTREES` | clean up worktrees, leases, persistence refs and source lock | `scripts/tackle-tasks/cleanupTaskWorktree.ts` |
| `COMMIT_IF_NEEDED` | commit if needed | `scripts/tackle-tasks/commitTaskWork.ts` |
| `MARK_TASK_INACTIVE_FAILURE` | mark task inactive in tasks.json | `scripts/tackle-tasks/markTaskInactive.ts` |
| `MARK_TASK_INACTIVE_SUCCESS` | mark task inactive in tasks.json | `scripts/tackle-tasks/markTaskInactive.ts` |
| `MERGE_WORKTREES` | Try: merge worktrees and submodules, no fast-forward | `scripts/tackle-tasks/mergeTaskWorktree.ts` |
| `RECORD_MERGE_COMMIT_HASHES` | record merge commit hashes to tasks.json | `scripts/tackle-tasks/recordMergeCommits.ts` |
| `RECORD_MODIFIED_FILES_FAILURE` | record modified files to tasks.json | `scripts/tackle-tasks/recordTaskModifiedFiles.ts` |
| `RECORD_MODIFIED_FILES_SUCCESS` | record modified files to tasks.json | `scripts/tackle-tasks/recordTaskModifiedFiles.ts` |
| `RELEASE_SOURCE_LOCK` | release the source repo lock | `scripts/tackle-tasks/releaseTaskRunHolds.ts` |
| `RELEASE_WORKTREE_LEASE` | release the worktree lease, keep the worktree | `scripts/tackle-tasks/releaseTaskRunHolds.ts` |
| `UPDATE_TASK_ENTRY` | update tasks.json entry | `scripts/tackle-tasks/recordPlanReview.ts` |
| `WRITE_EXIT_TYPE_AND_NOTE` | write exit type and exit notes to tasks.json | `scripts/tackle-tasks/writeTaskExitNotes.ts` |
| `WRITE_EXIT_TYPE_COMPLETED` | write exit type completed to tasks.json | `scripts/tackle-tasks/writeTaskExitNotes.ts` |

## Caveats — a script exists, but something is off

| Box id | Source file | The caveat |
|---|---|---|
| `LOCK_SOURCE_REPO` | `scripts/tackle-tasks/sourceRepoLock.ts`, `scripts/tackle-tasks/rebaseTaskWorktree.ts` | `sourceRepoLock.ts` is a library with **no CLI**. The bounded 5s-poll-to-15-minutes version, `acquireSourceRepoLockBounded`, lives inside `rebaseTaskWorktree.ts` — so the lock is taken **inside the rebase**, not at the preamble box the diagram draws. This is the box that throws today and stops every real run. |
| `UPDATE_AUTO_GENERATED_DOCS` | `scripts/tackle-tasks/updateTaskDocs.ts` | Has a CLI, but **no test file**. It is already called for real by `runPreamble`, so it is exercised, just not directly covered. |
| `WRITE_PUBLICATION_OUTCOME` | `scripts/tackle-tasks/writeTaskExitNotes.ts` | Can write the note, but the outcome it must write depends on the publication state, which nothing can read yet. Blocked on `READ_PUBLICATION_STATE`. |

## Needs no script

These are the workflow's own output, not work performed against the repository.

| Box id | Diagram label | Why |
|---|---|---|
| `REPORT_CLOSURE_NOTE` | report the closure note | The workflow returns it to the caller. |
| `REPORT_EXIT_TYPE_AND_NOTE` | report the run's exit type and note | The workflow returns it to the caller. |
| `STOP` | stop | Terminal marker only. |

## Missing — no implementation exists

| Box id | Diagram label | Notes |
|---|---|---|
| `READ_PUBLICATION_STATE` | read the publication state from the layer merge refs | Nothing reads or writes a per-layer merge ref. `mergeTaskWorktree.ts` merges and returns `{merged, commits, failureReason}`, but writes no ref for a later run to reconcile against. The strings `ALL LANDED` / `SOME LANDED` / `NONE LANDED` appear only in the tracer, the stepper and the workflow — never in a script. |
| `WRITE_CLARIFY_REQUEST` | write the clarify request into the tasks.json entry | Only `PlannerBodyEmitter.ts` mentions a clarify request, and only to ask the planner for one. Nothing writes it back into the entry. |

## Decisions that need a script to answer them

Separate from the script boxes above. Most decisions read a counter or an agent's result and need
nothing; these are the ones that must ask the repository.

| Box id | Answered by | Status |
|---|---|---|
| `DID_CHANGES_STAY_INSIDE_FENCE` | `scripts/tackle-tasks/checkTaskFileFence.ts` | Ready — CLI and tests. Derives the diff itself. |
| `DOES_RUN_HOLD_LEASE` | `readTaskWorktreeLeaseOwner` in `scripts/prepareTasks.ts` | Ready — library function, tested. |
| `DOES_RUN_HOLD_SOURCE_LOCK` | `readSourceRepoLock` in `scripts/tackle-tasks/sourceRepoLock.ts` | Ready — library function, tested. |
| `WAS_LOCK_ACQUIRED` | `acquireSourceRepoLockBounded` in `scripts/tackle-tasks/rebaseTaskWorktree.ts` | Exists, but see the `LOCK_SOURCE_REPO` caveat. |
| `HAVE_15_MINUTES_PASSED` | the same bounded poll | Exists, same caveat. |
| `WHAT_IS_PUBLICATION_STATE` | — | **Missing.** Same reader as `READ_PUBLICATION_STATE`. |
| `DID_ANY_WORK_LAND` | — | **Missing.** Same reader again. |

## The ten agent boxes, for contrast

These are the only boxes the workflow really performs today. All ten dispatch, and each one's schema
matches its emitter — locked by `tests/tackle-tasks/agentResultShapes.test.ts`.

| Role | Emitter | Return contract |
|---|---|---|
| `plan` | `PlannerBodyEmitter.ts` | `plans/plan-output-template.json` |
| `review-plan` | `CodexReviewBodyEmitter.ts` | `plans/review-plan-output-template.json` |
| `implement` | `ImplementBodyEmitter.ts` | `plans/implement-output-template.json` |
| `review-tests` | `CodexTestReviewBodyEmitter.ts` | `plans/review-tests-output-template.json` |
| `fix-conflicts` | `FixConflictsBodyEmitter.ts` | `plans/fix-conflicts-output-template.json` |
| `fix-suite` | `SuiteFixBodyEmitter.ts` | `plans/fix-suite-output-template.json` |
| `run-task-tests` | `RunTaskTestsBodyEmitter.ts` | `RunTaskTestsReceipt`; the skill hook runs `runTaskTests.ts` |
| `rebase-worktree` | `RebaseWorktreeBodyEmitter.ts` | `RebaseWorktreeReceipt`; the skill hook runs `rebaseTaskWorktree.ts` |
| `continue-rebase` | `ContinueRebaseBodyEmitter.ts` | `ContinueRebaseReceipt`; the skill hook runs `advanceTaskRebase.ts` |
| `run-full-suite` | `RunFullSuiteBodyEmitter.ts` | `RunFullSuiteReceipt`; the skill hook runs `runFullSuite.ts` |

## Scripts that exist but nothing calls

Working, tested code the current workflow never reaches. Each is either superseded by the v1.5
diagrams or waiting to be wired. Check before writing anything new.

`applyPlanAmendments.ts`, `validatePlanFile.ts`, `validateCodexReview.ts`, `decideTestReview.ts`,
`recordImplementationNotes.ts`, `reconcileStep.ts`, `checkResumedWorktreeFence.ts`,
`validateActiveTaskReceipt.ts`, `recoverSourceRepoLock.ts`.

Note that `checkResumedWorktreeFence.ts` and `validateActiveTaskReceipt.ts` **are** called, by
`runPreamble` — they are unreachable from the workflow only because the preamble runs before it.

## Suggested order of work

1. `LOCK_SOURCE_REPO` — the box that throws. Until it is wired, no real run gets past the rebase preamble.
2. `COMMIT_IF_NEEDED` — the highest-risk gap. An agent edits the worktree and nothing commits it.
3. The publication-state reader — one new script unblocks three boxes and the whole merge tail.
4. `WRITE_CLARIFY_REQUEST` — small, and only the clarify loop needs it.
5. The remaining ready boxes — pure wiring, no new logic.

## How to re-check

```
# every box the workflow steps through, with its diagram class
grep -o 'ctx\.L("[A-Z_0-9]*")' scripts/tackle-tasks/pipelines.ts | sed 's/ctx\.L("//;s/")//' | sort -u

# each script's self-declared diagram box, from its first line
head -1 scripts/tackle-tasks/*.ts

# which scripts have a CLI and a test
ls scripts/tackle-tasks/*.ts tests/tackle-tasks/*.test.ts
```
