# Task 4: make `/tackle-tasks` run end to end through `/run-step`

Written 2026-08-25 for the agent that rewrites the real workflow. Source code is the truth; this file only points at it.

## The guide

`scripts/tackle-tasks/monolith-pipeline.ts` is the design. `plans/diagram/_pipeline-monolith.mmd` draws its 18 blocks. Run it with:

```
bun scripts/tackle-tasks/monolith-pipeline.ts <1..8> scripts/tackle-tasks/monolith-pipeline.fixture/tasks.json
```

Every fake line in the monolith carries a `// live: <path>` comment naming the real box script under `scripts/steps/` and the helper under `scripts/tackle-tasks/` that does the work. Keep calling those helpers.

## Scope: not yet decided

Two ways to do this. Ask the user which one before starting.

1. **Loop first, keep the 133 boxes.** Rewrite `scripts/tackle-tasks/pipelines.ts` into the monolith's `main()` loop. `scripts/steps.json`, the `*.template.json` files and the box scripts stay. The hook already walks every `continue` box by itself.
2. **Full rewrite to the 17 blocks.** Also collapse `steps.json`, the templates and the box scripts to `pipeline-monolith.mmd`. This must fold 6 boxes in `scripts/steps/pipeline-rebase/` into 3.

## Keep out

Do not change the block output and block input shapes in `scripts/steps/pipeline-rebase/`. The user is working on them. Two known problems there, report only:
- `DID_REBASE_REPORT_CONFLICTS.ts` routes on `conflicted` only. A rebase stopped by a test failure (`failureReason` set, `conflicted` false) goes to the suite pipeline, and `REBASED_WORKTREE_INPUT.ts` drops `failureReason`.
- The `FIX_CONFLICTS` prompt tells the agent to commit with `stepId: "fix-conflicts"`; `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts` commits with `stepId: "rebase"`. They never match.

## Why the workflow cannot run today (all from code)

1. The 6 prompt boxes never go through `/run-step`. `pipelines.ts:129-166` sends them to `scripts/tackle-tasks/AgentPromptEmitter.ts` via `args.agentPromptEmitterPath` (`SkillBodyEmitter.ts:10,31`).
2. Every `/run-step` call is malformed. `pipelines.ts:172` puts the box name last; `scripts/runStepHook.ts:299-301` reads the first word as the box name. The hook answers "no block named <task number>". `tests/runStepHook.test.ts` never sends the workflow's shape.
3. The agent schema is wrong. `pipelines.ts:211` (`RUN_STEP_RESULT`) does not match the hook's `WalkResult` (`buildRunStepSchemas.ts:141-167`: `ok, ran, errors, outcome{box, scriptSignal, workflowSignal, next, payload, schema}`). `outcome.schema` and `workflowSignal` are never read by the workflow.
4. One `agent()` per box. `pipelines.ts` has 29 `runStep(ctx, "<BOX>")` call sites inside a hand-written 10-stage loop (`pipelines.ts:844-877`). The hook walks `continue` boxes in one call (`runStepHook.ts:203-270`); the workflow must call `agent()` only with the `next` the last outcome returned.
5. `skills/tackle-tasks/tackle-tasks.workflow.js:33` says "NOT WIRED … each throws". Stale; the code calls `ctx.agent()`.

The generated file must come from `pipelines.ts` (`generateTaskWorkflow.ts` + `tackle-tasks.workflow.template.js`); never edit `tackle-tasks.workflow.js` by hand. `tests/generateTaskWorkflow.test.ts` checks the two agree.

## What the monolith guarantees, and the rewrite must copy

- **One loop.** `main()` calls `agent()` once per hook stop, never per block. `agent()` invokes `/run-step <block>`; the hook walks until a prompt or a stop. Fixture task 1: 12 blocks, 5 `agent()` calls.
- **Prompt blocks are exactly these 6:** `PLAN_THE_TASK`, `CODEX_REVIEWS_PLAN`, `IMPLEMENT_TASK`, `CODEX_REVIEWS_TESTS`, `FIX_CONFLICTS`, `FIX_THE_CODEBASE_FOR_SUITE`. Marked `returns_a_prompt` in the diagrams; `steps.json` carries it as `producesPrompt`. Every other box runs as a script. The user ruled: no other box becomes a prompt box.
- **Schema per call.** The first `agent()` gets the schema of every block in the pipeline. `agent()` passes that list into `/run-step`. At the stop, the hook returns the same list with every block the run can no longer reach dropped (`runStep` filters it with `getSchemaReachableFrom(next)`, which walks through prompt blocks). A block on a retry path stays until the run passes it for good. The list only shrinks. The workflow passes the returned list to the next `agent()` as its structured output. `agent()` refuses a stop at a block the list did not name. Fixture task 9 shows `IMPLEMENT_TASK` stopping twice with the same 10-block list. Real: `buildRunStepSchemas.ts:buildAgentSchema(next)` rebuilds from scratch and stops at prompts; the hook must take the list in and filter it instead.
- **Null `agent()`** → the failures exit with `agent-failed`, like `pipelines.ts:406` does today. No new block.
- **Hook failure** (`ok: false`) → the agent returns the error unchanged; the loop prints it and stops with exit code 1.
- **Counters.** `attempts.clarify`, `attempts.testFixes`, `attempts.testReviews`, `attempts["pipeline-rebase-conflict-fix"]`, `attempts.merge`, `suiteFixAttempts` (payload only), `planReviewCount` on the entry. All cap at 2. Real ones live in `task.run.history[last].attempts` via `taskRunState.ts:getAttemptCount/raiseAttemptCount`.
- **File names** come from `scripts/tackle-tasks/preparedTask.ts:loadPreparedTask`, never from the payload: `plans/brief-N.md`, `plans/plan.json`, `plans/codex-review.json`, `plans/test-review.json`, `plans/implementation-notes-N.md`, `plans/implementation-diff-N.patch`.

## Rulings already applied to the monolith; carry each into the real code

| # | Ruling | Real file to change |
|---|--------|---------------------|
| 3 | "2 codex test reviews done?" counts `attempts.testReviews`, not "does `codexReviewNotes` have text" | `scripts/steps/pipeline-reviewTests/ARE_2_TEST_REVIEWS_DONE.ts:hasAlreadyBeenAmended` (the shared field is also written by `AMEND_ENTRY_WITH_FAILING_TESTS.ts` and `UPDATE_TASK_ENTRY.ts`) |
| 6 | record merge hashes, then write `completed` | already the real order; `pipeline-mergeSucceededExit.mmd` comment fixed |
| 7 | plan-review ERROR exit note carries codex's message | already `VERDICT_ERROR.ts` |
| 8 | plans with 12+ sections graded by efficacy percentage | already `scripts/planReviewRuling.ts`; keep it |
| 1, 2 | `agent-failed` and `run-failed` exits | new generic loop in `pipelines.ts` |
| 5, 9 | plan is `plans/plan.json`, brief is `plans/brief-N.md` | already `preparedTask.ts` |
| 11 | schema list is passed in, filtered to blocks still reachable, and returned | `runStepHook.ts` must take the list in; `buildRunStepSchemas.ts:getStepsReachableFrom` must walk through prompt blocks; the workflow must use `outcome.schema` |
| 13 | `not-resumable` is an exit type | `_pipeline.mmd` fixed; `writeTaskExitNotes.ts` EXIT_TYPES must list it |

## Dead code the rewrite may delete

`scripts/tackle-tasks/recordPlanReview.ts`, `applyPlanAmendments.ts`, `validateCodexReview.ts` (no box script imports them). `AgentPromptEmitter.ts` and `PreambleDataEmitter.ts` are alive only through blocker 1. `skills/tackle-tasks/failed/` holds an older generation.

## Facts about the hook the rewrite must respect

- `scripts/runStepHook.ts`: 10 s per box (`STEP_TIMEOUT_MS`), 60 s for the whole hook.
- A box with one successor may omit `next`; a decision box must name it, and it must be in `steps.json`'s `next[]`.
- A box marked `returns_a_prompt` must print `scriptSignal: "prompt"`, and only such a box may. The hook fails the walk either way.
- The start input is checked against the start box's template `input`.
- `skills/run-step/SKILL.md`: the agent does nothing unless `outcome.scriptSignal` is `prompt`; then it follows `outcome.payload.prompt` and returns the whole result with its answer as `outcome.payload`.

## Vocabulary

Say "block output", "block input", "payload", "one of the exit paths of a decision block", "marked active / inactive". Do not say claim, seam, arm, hand-off, door.

## How to check the work

- `tsc -p tsconfig.json`
- `node --test tests/runStepHook.test.ts`, `node --test tests/generateTaskWorkflow.test.ts`
- Full suite: `npm test 2>&1 | rg -e '^✖' || echo "all passing"`
- The monolith fixtures 1-8 still run to "reached end of pipeline".
