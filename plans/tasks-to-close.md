# Open-task audit against tackle-tasks v1.6

Audited at commit `0fbe014f89471f3ffbc518de301431eb9b9f4e92`.

Scope: does the task's *intent* already exist in the current v1.6 pipeline —
`skills/tackle-tasks/tackle-tasks.workflow.js` + `scripts/tackle-tasks/**`,
plus whatever those files actually import (`prepareTasks.ts`,
`mergeTaskWorktrees.ts`, `checkBlockers.ts`, `taskFiles.ts`, `contracts.ts`)?

Confirmed by grep that `scripts/tackle-tasks/**` never imports
`mergePipeline.ts`, `runMergePhase.ts`, `operationBranches.ts`,
`runConsolidation.ts`, `operationPush.ts`, `basePublication.ts`, or
`approvalGate.ts`. Those are v1/v1.1/v1.5 (or batch cross-repo publication)
only — evidence drawn from them does not prove anything about v1.6, and a
real bug in them is out of scope for this audit.

Tasks not about the tackle-tasks pipeline (74, 79, 101, 102, 106, 107, 109,
110, 113, 116, 187, 189, 190) were not re-scoped here — see the prior pass
in this conversation for those.

## Close — v1.6 already does this

| # | Evidence |
|---|----------|
| 80 | `scripts/tackle-tasks/shared/mergeTaskWorktree.ts`'s `verifySourceTipsUnchangedSinceRebase` throws if the target moved since rebase, forcing the retry loop instead of a blind merge — destination drift is caught. |
| 82 | `skills/tackle-tasks/plan.workflow.js`/`verify.workflow.js` (the two-barrier-across-all-tasks design) are gone; each task now runs its own independent block chain, so no task's plan phase can block another's verify phase. |
| 83 | `scripts/tackle-tasks/codexReviewsPlan/CODEX_REVIEWS_PLAN.ts` + `whatIsReviewVerdict/WHAT_IS_REVIEW_VERDICT.ts` already drive review from a machine-readable ruling (`scripts/planReviewRuling.ts`), planner applies fixes. |
| 87 | `scripts/tackle-tasks/shared/writeTaskBrief.ts`'s `writeTaskBriefToDisk` runs unconditionally from `preambleStatusCheck/DOCUMENT_GENERATION.ts` on every launch — brief is always regenerated, never hand-edited. |
| 90 | `pipeline-runFullSuite.mmd`: `ARE_2_SUITE_FIXES_DONE_Q` → `FIX_THE_CODEBASE_FOR_SUITE` loop runs the suite again and fixes what the rebase broke. |
| 96 | v1.6 doesn't call `taskGroups.ts`'s grouping/`declaredFiles` logic at all — `_createFreshTaskWorktree.ts` builds its own single-task group inline. The divergence-risk this task named isn't reachable from the live pipeline (the flat-`task.files` problem it worried about still exists, just relocated — see 97). |
| 103 | `run-steps.json` aggregation is retired (task 147); v1.6 has no equivalent aggregate-file-write step to fix. `scripts/steps.json` is an unrelated file (the block-graph config `runStepHook.ts` loads). |
| 104 | `CREATE_WORKTREE.ts` → `createFreshTaskWorktree(taskNumber, ...)` — worktrees are named by task number. |
| 115 | `pipeline-rebase.mmd` → `pipeline-runFullSuite.mmd` merges only after `DO_ALL_TESTS_PASS_Q` succeeds, with a capped retry lap via `ARE_2_MERGE_ATTEMPTS_DONE_Q`. |
| 117 | Bug no longer reproduces (re-ran under both `bun test` and `node --test`); `mergeTaskWorktrees.ts` is a live v1.6 dependency via `mergeTaskWorktree.ts`. |
| 121 | No file under `scripts/tackle-tasks/` inlines a duplicate of `blockerVerdicts.ts`'s constants; the only file that did (`blockers.workflow.js`) is dead. |
| 161 | Confirmed not applicable to v1.6: the `operations/<runId>` ref this task wants deleted is never created by anything v1.6 calls. `attachOperationBranch` in `prepareTasks.ts` (which v1.6 *does* import) is an unrelated one-liner that just tags `operationBranch: "task-<N>"" — same name, nothing to do with the ref-naming/deletion mechanism in `operationBranches.ts`/`runConsolidation.ts`, which v1.6 never touches. |
| 165 | Same finding as 161 — the double-sanitize branch-naming bug is real but lives entirely in `mergePipeline.ts`/`operationBranches.ts`, code v1.6 never calls. |
| 184 | Its target file and serial-chain mode are gone outright (dropped in the diagram-pipeline rewrite, not relocated). The replacement need (loop until tasks.json is empty) is already tracked as its own task in "correct workflow 40"'s list. |
| 186 | Done at commit `77ecaee` — `WHAT_DID_THE_PLANNER_RETURN.ts`/`DO_TASK_TESTS_PASS_Q.ts` both gate on `difficulty <= 2`. |

## Keep open, but re-target (task names the wrong file)

| # | Correct target | Why |
|---|---|---|
| 97 | `scripts/tackle-tasks/shared/checkTaskFileFence.ts`, `checkResumedWorktreeFence.ts`, `_createFreshTaskWorktree.ts` | Not `approvalGate.ts`/`mergePipeline.ts` — v1.6 has its own fence enforcement in these three files, and all three still read flat `task.files` with no read/modify split. |
| 118, 120 | `scripts/tackle-tasks/shared/CodexReviewBodyEmitter.ts` | Not `verify.workflow.js` (deleted). This is the live plan-review prompt; confirmed it carries none of the 4 recurring-rejection categories or "not grounds for rejection" guidance. |
| 164 | `scripts/runStepHook.ts`'s `additionalContext`/`injectResult` path | Not `stage-and-summarize-stop.ts` (its diff-printing code is commented out and the file is otherwise retired). Read `runStepHook.ts` directly — `injectResult` never surfaces the actual staged diff either, so the need is real, just needs a new home. |

## Keep open, target already correct

| # | Confirmed via |
|---|---|
| 93 | `prepareTasks.ts`'s `renderTaskBriefContent` (called by `writeTaskBrief.ts`, a genuine v1.6 dependency) still embeds full file contents instead of paths. |
| 105 | Brief/plan generation-and-cleanup before merge is already implemented (`cleanupPlanAndBriefFiles` in the merge-success path). Only gap: 175 already-tracked legacy `plans/brief-N.md` files from old completed tasks were never drained. Rescope to just that backlog drain. |
| 114 | `scripts/tackle-tasks/shared/isTaskBlocked.ts` calls `scripts/checkBlockers.ts`'s `blockerReport`, which still has no cycle detection over the `blockedBy` graph. |
| 191 | `scripts/generateSteps.ts` (which builds v1.6's own `scripts/steps.json`) still hardcodes the diagram-folder fallback; no `.taskTools/settings.json` read anywhere. |

## Needs your answer

**188** — Found a veto, but for a different proposal. The Aug 28 5:36pm
session ("tackle-tasks: Proposed Feature Set for v2 Architecture") rejected
**Feature 3: per-run block-payload logging in SQLite** (storing block
input/output/command JSON with a 15-day purge — an unrelated proposal). That
assessment (`~/.claude/plans/virtual-dreaming-lighthouse.md`) explicitly
calls task 188 "a separate concern... covers task metadata, not run data"
and does not rule on it. No record found of 188 itself (migrating
`tasks.json` to SQLite with tags) being vetoed. Its named plumbing target
(`createTask.workflow.js`'s file-hunter/blocker-hunter agents) is gone
regardless — `create-task` is now a single-script stub — so it needs a
rewrite either way. Confirm whether 188 was rejected too, or close it as
still-open-but-needs-a-rewrite.

## Not re-scoped here (unchanged from the prior pass)

74, 79, 96(covered above), 101, 102, 106, 107, 109, 110, 113, 116, 187, 189,
190 — these concern other skills (`pick-a-task`, `update-tasks`, `rate-task`,
`split-task`, `commit-message`, `task-stats`, top-level `scripts/`
reorganization, `create-task`, `doneFileMonitor`, result codes, `mermaid`),
not the tackle-tasks v1.6 pipeline, so the legacy/v1.6 distinction doesn't
apply to them.
