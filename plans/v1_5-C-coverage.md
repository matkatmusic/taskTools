# v1.5 [C] coverage map

Which source files already do what `plans/tackle-tasks-v1_5-prompt.md` marks `[C]` (runs as code, no agent).

The diagrams in `plans/diagram/*.mmd` are the source of truth. This file is a census only — no fixes proposed.

## Tag split

`plans/tackle-tasks-v1_5-prompt.md` has **97** numbered paragraphs (not 98).

| tag | count | paragraphs |
|---|---|---|
| `[M]` main agent only | 1 | 1 |
| `[S]` subagent | 6 | 23, 30, 36, 45, 58, 63 |
| `[C]` code | 90 | all the rest |

## Score

| status | count | share |
|---|---|---|
| COVERED | 35 | 39% |
| PARTIAL | 34 | 38% |
| MISSING | 21 | 23% |

Read that as: the **boxes** are largely built, the **glue between them** is not.

## The one-line summary

`scripts/tackle-tasks/*.ts` holds ~45 solid per-box primitives. What does not exist is a real
orchestrator that calls them in diagram order. `skills/tackle-tasks/tackle-tasks.workflow.js`
carries the line `/** Real mode is deliberately not built. */`, and `scripts/tracePipeline.ts` is a
diagram-walking test oracle that explicitly touches no repository. Every paragraph scored PARTIAL
"exists only in trace/simulation" traces back to those two files.

## Run (1-5)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 2 | atomic tasks.json, deepest-submodule-first layer walk | `tackle-tasks/taskStateLock.ts:withTaskStateLock`, `tackle-tasks/occurrences.ts` | COVERED |
| 3 | operational script failure ends run as `run-failed` | test harness only (`pipeline.e2e.test.ts:box`) | PARTIAL — convention, no production dispatcher |
| 4 | reconcile before retrying a mutating box | `tackle-tasks/reconcileStep.ts:reconcileStep` | COVERED |
| 5 | counters count fix attempts, in-memory, rebase does not reset | `tracePipeline.ts:MAX_ATTEMPTS` | PARTIAL — simulation only; no-reset nuance unmodelled |

## Preamble status check (6-12)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 6 | preamble runs before active mark; every exit is report-only | emergent from wiring | PARTIAL — no single enforcing function |
| 7 | task number valid, tasks.json only | `tackle-tasks/isTaskNumberValid.ts:isTaskNumberValid` | COVERED |
| 8 | task blocked | `tackle-tasks/isTaskBlocked.ts:isTaskBlocked` → `checkBlockers.ts:blockerReport` | COVERED |
| 9 | check active and mark active as one atomic write | `tackle-tasks/taskRunState.ts:claimTask` | COVERED |
| 10 | already active stops, never touches the found run | `tackle-tasks/isTaskActive.ts:isTaskActive` refused path | COVERED |
| 11 | ambiguous claim re-reads tasks.json | `tackle-tasks/reconcileStep.ts:reconcileIsTaskActive` | COVERED |
| 12 | worktree existence asked once | `tackle-tasks/doesTaskWorktreeExist.ts:doesTaskWorktreeExist` | COVERED |

## Worktree check (13-20)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 13 | create worktree, take lease, emit docs mode AUTOGEN | `tackle-tasks/createTaskWorktree.ts:createTaskWorktree` | PARTIAL — no `docsMode` value exists |
| 14 | worktree structurally safe | `tackle-tasks/checkTaskWorktreeSafe.ts:checkTaskWorktreeSafe` | COVERED |
| 15 | resumable, asked only of a safe worktree, adopts lease | `tackle-tasks/isTaskRunResumable.ts:isTaskRunResumable` | PARTIAL — callers ask it on the unsafe edge, the opposite of the rule |
| 16 | unsafe: take lease before reset | `tackle-tasks/resetTaskWorktree.ts:resetTaskWorktree` | COVERED |
| 17 | safe but not resumable resets | same symbol | PARTIAL — call sites route reset differently |
| 18 | resumption is worktree-level, always restarts at docs+plan | emergent from wiring | PARTIAL — not a checkable unit |
| 19 | recursive submodule init, carry docs mode forward | `tackle-tasks/initTaskSubmodules.ts:initTaskSubmodules` | PARTIAL — docs-mode threading absent |
| 20 | route on docs mode AUTOGEN vs UPDATE | `tackle-tasks/generateTaskDocs.ts`, `tackle-tasks/updateTaskDocs.ts` | PARTIAL — router inlined per caller, no named symbol |

## Document generation (21-22)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 21 | UPDATE docs read the clarify request and grow to cover it | `tackle-tasks/updateTaskDocs.ts:updateTaskDocs` | PARTIAL — never reads a clarify request; no such field exists |
| 22 | generated docs never committed | `tackle-tasks/writeTaskBrief.ts:configureGeneratedArtifactIsolation` | COVERED |

## Plan (24-29)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 24 | route planner return on PLAN / CLARIFY / ERROR | none | MISSING |
| 25 | on PLAN hand to review-plan | `tackle-tasks/PlanningPipelineEmitter.ts` is a bare type stub | MISSING |
| 26 | on ERROR exit `agent-failed` | `tracePipeline.ts` shape only | PARTIAL — trace only |
| 27 | CLARIFY capped at 2 rounds, within-run | none | MISSING |
| 28 | write clarify request to tasks.json, carry to UPDATE docs | none | MISSING |
| 29 | second CLARIFY exits `clarify-stuck` | none | MISSING |

## Review plan (31-35)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 31 | review agent error exits `agent-failed` | `tracePipeline.ts` shape only | PARTIAL — trace only |
| 32 | on ACCEPT hand plan to implement | `tackle-tasks/planArtifacts.ts:readAndValidateReview` | PARTIAL — only parses `amend`/`scrap`; accept is implicit |
| 33 | on AMEND/SCRAP write notes to tasks.json, raise counter | `tackle-tasks/applyPlanAmendments.ts` | PARTIAL — edits the plan file, not tasks.json; no counter |
| 34 | under 2 reviews, replan | `tracePipeline.ts` | PARTIAL — trace only |
| 35 | second non-accept exits `plan-scrapped` | `tracePipeline.ts` | PARTIAL — trace only |

## Implement (37-41)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 37 | implement agent error exits `agent-failed` | `tracePipeline.ts` | PARTIAL — trace only |
| 38 | commit if dirty, skip clean, exclude generated docs | `tackle-tasks/commitTaskWork.ts:commitTaskWork` | COVERED |
| 39 | source lock not taken during implement | confirmed absent from implement-side scripts | COVERED by omission |
| 40 | re-entry writes what went wrong into tasks.json first | none | MISSING |
| 41 | run only this task's tests, never the full suite | `tackle-tasks/runTaskTests.ts:runTaskTests` | COVERED |

## Task tests (42-44)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 42 | ask the fix counter before amending | none | MISSING |
| 43 | under 2 fixes, write failing tests to tasks.json, raise counter | none | MISSING |
| 44 | third failing run exits `tests-red` | `tracePipeline.ts` | PARTIAL — trace only |

## Review task tests (46-51)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 46 | pass codex 7 inputs, diff derived from merge-base | `tackle-tasks/AgentPromptEmitter.ts:reviewTestsPrompt` passes 3 | MISSING |
| 47 | review agent error exits `agent-failed` | none | MISSING |
| 48 | not flagged, hand to rebase preamble | `tackle-tasks.workflow.template.js:implementTestPhase` | PARTIAL — implement-phase loop, not this pipeline |
| 49 | first flag amends tasks.json, re-enters implement | same + `AgentPromptEmitter.ts:amendTestsPrompt` | PARTIAL — same caveat |
| 50 | second flag exits `tests-flagged` | `tackle-tasks.workflow.template.js` | PARTIAL — note text differs |
| 51 | lock the source repo, owner `runId:taskNumber` | `tackle-tasks/sourceRepoLock.ts:acquireSourceRepoLock`, `buildLockOwner` | COVERED |

## Rebase preamble (52-56)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 52 | wait 5s, retry, up to 15 minutes | `rebaseTaskWorktree.ts:acquireSourceRepoLockBounded` uses 10s / 2 min | PARTIAL — wrong constants |
| 53 | after 15 min exit `run-failed` with that note | none | MISSING |
| 54 | lock file under `<projectRoot>/.git`, cleared by hand | `tackle-tasks/sourceRepoLock.ts:sourceRepoLockPath`, `recoverSourceRepoLock.ts` | COVERED |
| 55 | every rebase/suite/merge box refreshes the heartbeat on entry | `sourceRepoLock.ts:refreshOwnedSourceRepoLockOrThrow` | PARTIAL — `runFullSuite.ts` never calls it |
| 56 | rebase onto target head, deepest layer first | `tackle-tasks/rebaseTaskWorktree.ts:rebaseTaskWorktree` | COVERED |

## Rebase (57-61)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 57 | skip every layer the merge receipt records as landed | none | MISSING — the known divergence, confirmed |
| 59 | conflict-fix agent error exits `agent-failed` | none | MISSING |
| 60 | commit resolution, then continue the rebase | `tackle-tasks/commitTaskWork.ts`, `tackle-tasks/advanceTaskRebase.ts:advanceTaskRebase` | COVERED |
| 61 | after 2 conflict fixes exit `rebase-stuck` | `tackle-tasks.workflow.template.js:rebaseMergePhase` | COVERED — note text matches exactly |

## Full suite (62-69)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 62 | run the full suite, never progress until green | `tackle-tasks/runFullSuite.ts:runFullSuite` | COVERED |
| 64 | commit the repair before rerunning | `tackle-tasks/commitTaskWork.ts` | COVERED |
| 65 | suite-fix agent error exits `agent-failed` | none | MISSING |
| 66 | after 2 attempts exit `suite-red` | `tackle-tasks.workflow.template.js` | PARTIAL — note text differs |
| 67 | re-derive the diff, check the file fence, never trust a caller | `tackle-tasks/checkTaskFileFence.ts:checkTaskFileFence` | COVERED |
| 68 | fence violation exits `fence-violation` | `tackle-tasks.workflow.template.js` | PARTIAL — note text differs |
| 69 | known ceiling: refresh per box, no background timer | `tackle-tasks/sourceRepoLock.ts` (no `setInterval`) | COVERED |

## Merge (70-79)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 70 | merge worktrees and submodules, no fast-forward | `tackle-tasks/mergeTaskWorktree.ts:mergeTaskWorktree` | COVERED |
| 71 | each layer writes its merge ref as it lands | `mergeTaskWorktrees.ts:recordMergedCommit` | COVERED |
| 72 | read publication state from the layer merge refs | `mergeTaskWorktrees.ts:findRecordedMergedCommit`, `reconcileStep.ts:reconcileMergeTaskWorktree` | PARTIAL — reconciles one step's own result, not a general query |
| 73 | map layer status to ALL / NONE / SOME LANDED | none | MISSING |
| 74 | ALL LANDED hands receipt to the succeeded exit | none | MISSING |
| 75 | NONE LANDED under 2 attempts re-enters rebase | old `tackle-tasks.workflow.js` retry loop | PARTIAL — retries on a boolean, not a publication read |
| 76 | 2 attempts done exits `merge-failed` | old `tackle-tasks.workflow.js:exitChain` | PARTIAL — note text differs |
| 77 | SOME LANDED never retries, exits `partially-published` | none | MISSING |
| 78 | a no-op layer is a real completion | `mergeTaskWorktrees.ts:mergeTaskDeepestFirst`, `tackle-tasks/occurrences.ts` | COVERED |
| 79 | record hashes then write `completed`, point of no return | `tackle-tasks/recordMergeCommits.ts`, `tackle-tasks/writeTaskExitNotes.ts` | COVERED |

## Merge succeeded exit (80-84)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 80 | record modified files on the run record | none | MISSING — only a no-op prose stub |
| 81 | only box releasing both holds; re-prove ownership, release last | `mergeTaskWorktrees.ts:removeTaskWorktreeAndBranches`, `deleteTaskMergePersistence` | PARTIAL — primitives exist, no single success-tail caller |
| 82 | build the closure note, then mark inactive | `tackle-tasks/markTaskInactive.ts:markTaskInactive` | PARTIAL — no closure-note builder |
| 83 | archive to completedTasks.json, unblock dependents, stop | `tackle-tasks/closeTaskRun.ts:closeTaskRun` → `closeTasks.ts:closeTaskRunReconciled` | COVERED |
| 84 | safety comes from the refs, not from this tail | design property of 71 and 79 | COVERED |

## Failures exit (85-95)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 85 | ask git what landed before writing anything | none | MISSING — `exitChain` writes the exit type first |
| 86 | work landed keeps `completed` or writes `partially-published` + `cleanup-incomplete` | none | MISSING |
| 87 | nothing landed writes the incoming exit type and note | `tackle-tasks/writeTaskExitNotes.ts:writeTaskExitNotes` | COVERED |
| 88 | record modified files, empty list when no worktree | none | MISSING |
| 89 | release the worktree lease only on owner match | `tackle-tasks/releaseTaskRunHolds.ts:releaseTaskRunHolds` | COVERED |
| 90 | ask about the source lock independently | same symbol → `sourceRepoLock.ts:releaseSourceRepoLock` | COVERED |
| 91 | mark inactive last, after every release and write | `tackle-tasks/markTaskInactive.ts` | PARTIAL — old `exitChain` marks inactive BEFORE releasing |
| 92 | report exit type and note only, then stop | old `tackle-tasks.workflow.js:exitChain` | COVERED |
| 93 | the failures tail never removes the worktree | `releaseTaskRunHolds.ts` releases lease only | COVERED |
| 94 | every mutating tail box is reconciled, not retried | `tackle-tasks/reconcileStep.ts:reconcileStep` | PARTIAL — not wired into the tail boxes |
| 95 | `cleanup-incomplete` and `partially-published` are recovery only | none | MISSING |

## Report only exit (96-97)

| ¶ | behavior | file:symbol | status |
|---|---|---|---|
| 96 | pre-active exits report and stop, nothing to write | old `tackle-tasks.workflow.js:exitChain` `held.noRunRecord` | COVERED |
| 97 | `already-active` must not touch the run it finds | `tackle-tasks/isTaskActive.ts` | PARTIAL — read-only by construction, no test proves the rule |

## The four clusters behind every MISSING

**1. Publication state — ¶72, 73, 74, 77, 85, 86, 95.** The refs are written (¶71 COVERED) but
nothing reads them into an ALL / NONE / SOME LANDED verdict, and both exit tails still trust the
incoming exit type. This is the largest single gap and the core v1.5 novelty.

**2. Missing exit types.** `tackle-tasks/taskRunState.ts:TaskExitType` holds twelve values:
`completed`, `invalid-number`, `already-active`, `blocked`, `plan-scrapped`, `tests-red`,
`tests-flagged`, `suite-red`, `rebase-stuck`, `merge-failed`, `fence-violation`, `run-failed`.
Four from the diagrams are absent: `closing`, `clarify-stuck`, `agent-failed`,
`partially-published`. `agent-failed` alone accounts for ¶26, 31, 37, 47, 59, 65.

**3. CLARIFY — ¶21, 24, 27, 28, 29.** Zero hits for "clarify" under `scripts/` or `skills/`. Not
wired, not written. `updateTaskDocs.ts` takes no clarify input, which blocks the rest.

**4. In-run counters and their tasks.json notes — ¶33, 40, 42, 43.** No fix-attempt counter exists
in runtime code, and nothing writes failing tests or codex notes back into the task entry. Only
`tracePipeline.ts` models the ordering.

Smaller and separate: **note text drift** (¶50, 66, 68, 76) where the exit type and trigger are
right but the wording differs from the diagrams, and **no `docsMode` value** (¶13, 19, 20) where
callers branch straight to the right script instead of threading a mode.

## Where the paragraphs and the code disagree on shape

- ¶15 to 17: the diagrams ask resumability **only of a safe worktree**. Every existing wiring
  (`pipeline.e2e.test.ts:runPipeline`, `tackle-tasks.workflow.js:preamblePhase`,
  `tracePipeline.ts`) asks it on the unsafe edge instead.
- ¶46 to 50: the diagrams draw a separate post-implementation review-task-tests pipeline taking
  seven inputs. Only the earlier three-input in-loop review exists.
- ¶52: the diagrams say 5s poll, 15 minute ceiling. The code says 10s poll, 2 minute ceiling.
- ¶55: "every box refreshes the heartbeat" is false — `runFullSuite.ts` does not.
