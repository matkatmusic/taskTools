# Handoff: finish testing the tackle-tasks workflow and skill

Branch: `fix-tackle-tasks-workflow-script-imports`
Written by the session that took the suite from 1079 failures to 32.

## State right now

`npm test` → **2679 pass, 32 fail**. Every one of the 32 is pre-existing and was
verified by stashing this session's changes and re-measuring the same files:
identical counts with and without them.

The 32 live in four files:

| File | Fail | Cause |
|---|---|---|
| `tests/tackle-tasks/workflowBehavior.test.ts` | 21 | `ReferenceError: phase is not defined`, and much more underneath — see task 1 |
| `tests/tackle-tasks/SkillBodyEmitter.test.ts` | 4 | `error: No such remote 'origin'` |
| `tests/mmdGraph.test.ts` | 1 | `pipeline.mmd` node `FAILED` has no label |
| `tests/tackle-tasks_bootstrap.workflow.test.ts` | 1 | ENOENT on an archived workflow file |

Green and trustworthy:
- `tests/workflowMatchesTracer.test.ts` — 700 pass. Diffs `tracePipeline.ts`
  against `tackle-tasks.workflow.js` in FAKE mode for every fixture.
- `tests/tracePipeline.test.ts` — 19 pass.
- `tests/stepPipeline.test.ts` — 2 pass.
- `npx tsc --noEmit` — clean.

## What this session changed, so you do not redo it

1. `scripts/tracePipeline.ts` — `AgentBoxName` grew from 6 to 10. Added
   `TEST_RUNNER`, `REBASER`, `REBASE_ADVANCER`, `SUITE_RUNNER`. Four steps that
   were plain `push()` lines now go through `agentBox()`, so they print the
   `<-- AGENT --> ` prefix and can take the `AGENT_ERRORED` / `AGENT-FAILED`
   exit: `RUN_TASK_TESTS`, `REBASE_ONTO_TARGET_BRANCH`, `CONTINUE_REBASE`,
   `RUN_FULL_SUITE`. This matches the diagrams (`pipeline-taskTests.mmd:58`,
   `pipeline-suite.mmd:71`, `pipeline-rebase.mmd:71`) and the workflow. The
   workflow was already correct; the tracer was the stale one.
2. `tests/workflowMatchesTracer.test.ts` — the harness now passes
   `args.task`. The workflow reads `const TASK = args.task`; the harness only
   passed `{ fake }`, so every trace began `Task Num [undefined]`. Fixed in the
   harness, NOT by adding a fallback in the workflow.
3. `scripts/generatePipelinePaths.ts` — rewritten. The old one imported a
   deleted `ReceiptName` type and read four `.mmd` files the diagram split had
   deleted.
4. `scripts/tracePipelinePaths.json` — regenerated, 700 fixtures. **Task 5
   replaces this entirely.**
5. `scripts/tackle-tasks/stepPipeline.ts` + its test — the retired
   `ReceiptName` / `--malformed` receipt concept removed.
6. `tests/tracePipeline.test.ts` — rewritten for the current schema; 22 tests
   describing retired behaviour deleted.
7. `tests/tackle-tasks_SkillBodyEmitter.test.ts` and
   `tests/tackle-tasks-v1_1_SkillBodyEmitter.test.ts` — the archived-workflow
   assertion now expects `["tackle-tasks.workflow.js"]`. Commit `922f7a1`
   moved `blockers`, `bootstrap`, and `resolve` into `failed/`.
8. `scripts/generatePipelinePaths.ts:44` — `AGENT_BOXES` was still the old six,
   so no fixture ever exercised the four new boxes' error paths. Fixed to all
   ten. **Deliberately not regenerated**, because task 5 redesigns the
   generator and that output would be thrown away.

Decisions already made by the user. Do not re-litigate these.

- Preamble and malformed-receipt paths are OUT of the tracer. The preamble runs
  in `PreambleDataEmitter.ts` before the workflow launches and is covered by
  `tests/PreambleDataEmitter.test.ts` (7 pass). The v1.5 diagrams dropped the
  receipt-validity boxes.
- `pipeline.mmd`'s unlabelled `FAILED` node is NOT a problem. It is an
  overview diagram.

---

## Task 1 — rewrite `tests/tackle-tasks/workflowBehavior.test.ts`

21 tests, 0 passing. `phase` is only the surface error. The file is written
against a **pre-v1.5 contract** and needs a real rewrite, not a patch.

Three separate mismatches:

1. `tests/tackle-tasks/workflowBehavior.test.ts:122` declares
   `["args", "log", "agent"]`. The workflow calls `phase()`. Add `"phase"` and
   pass a no-op, exactly as `tests/workflowMatchesTracer.test.ts` already does.
2. Line 127 passes args as a JSON **string**:
   `JSON.stringify({ ...workflowArgs, ...argsOverride })`. The current workflow
   does `args && typeof args === 'object' ? args.fake : null` and
   `const TASK = args.task`. Pass a real object.
3. The stub map is built around script boxes that no longer exist:
   `isTaskNumberValid`, `isTaskOpen`, `isTaskActive`, `isTaskBlocked`,
   `doesTaskWorktreeExist`, `createTaskWorktree`, `resetTaskWorktree`,
   `isTaskRunResumable`, `checkTaskWorktreeSafe`, `generateTaskDocs`,
   `updateTaskDocs`, `initTaskSubmodules`, `validatePlanFile`,
   `validateCodexReview`, `applyPlanAmendments`, `recordImplementationNotes`,
   `commitTaskWork`, `closeTaskRun`. The current workflow dispatches exactly
   ten agent boxes and nothing else.

The ten boxes, with the role string each passes to the emitter:

| Box | Role |
|---|---|
| `PLANNER` | `plan` |
| `PLAN_REVIEWER` | `review-plan` |
| `IMPLEMENTER` | `implement` |
| `TEST_RUNNER` | `run-task-tests` |
| `TEST_REVIEWER` | `review-tests` |
| `REBASER` | `rebase-worktree` |
| `CONFLICT_FIXER` | `fix-conflicts` |
| `REBASE_ADVANCER` | `continue-rebase` |
| `SUITE_RUNNER` | `run-full-suite` |
| `SUITE_FIXER` | `fix-suite` |

Verified: those ten roles match the ten `case` arms in
`scripts/tackle-tasks/AgentPromptEmitter.ts` exactly. No gap.

Keep the coverage the 700 fixture paths do NOT give: the payload handed to each
agent box, retry caps, and exit-type reconciliation. Delete any test whose
subject no longer exists rather than inventing workflow behaviour to keep it
alive.

## Task 2 — write a real-mode test

Everything proven today runs through `args.fake`. FAKE mode bypasses every line
that reads an agent's actual result.

Build it as: run the workflow with `isFake()` false and a stub `agent()` that
returns schema-shaped results. Hermetic, no network, no model calls, no real
task. It must exercise the real result-reading paths that FAKE mode skips:

```
testRun.passed        (taskTestsPipeline)
result.outcome        (planPipeline)
result.verdict        (reviewPlanPipeline)
result.flagged        (reviewTestsPipeline)
rebaseRun.conflicted  (rebasePipeline)
continueRun.finished  (rebasePipeline)
suiteRun.passed       (suitePipeline)
```

Also cover `runAgent` returning `null`, which is the dotted `agent() errored`
edge, and `notWired()` for the two `decide()` call sites that have no real
implementation yet: `LOCK_SOURCE_REPO` / `lockAcquired`, and
`WHAT_IS_PUBLICATION_STATE` / `publicationState`.

Do NOT build the full end-to-end variant on a scratch repo. The user chose the
stubbed-agent form.

## Task 3 — clear the dangling archived-workflow paths

Commit `922f7a1` archived `resolve`, `bootstrap`, and `blockers` workflows into
`skills/tackle-tasks/failed/`. Three live code paths still point at their old
locations and would hand an agent a `scriptPath` that does not exist:

- `scripts/tackle-tasks/SkillBodyEmitter.ts:43` — `RESOLVE_WORKFLOW_PATH`,
  used at line 48 as `scriptPath`.
- `scripts/tackle-tasks_SkillBodyEmitter.ts:6` — `bootstrapWorkflowPath`, used
  at line 14.
- `scripts/tackle-tasks_SkillBodyEmitter.ts:10` — `blockersWorkflowPath`, used
  at lines 239 and 275.

User's decision: **remove the features that call them.** Do not repoint them at
`failed/` — they were archived as failed, so re-wiring them ships known-broken
workflows. Delete the constants and the emitter prose that instructs an agent to
call `Workflow` with those scriptPaths.

## Task 4 — delete two tests

- `tests/tackle-tasks_bootstrap.workflow.test.ts` — remove it. It reads an
  archived file.
- `tests/tackle-tasks/SkillBodyEmitter.test.ts` — the 4 tests failing with
  `No such remote 'origin'`. The user's ruling: **checking whether code has been
  pushed is not a test.** Remove those 4. Keep the other 8, which pass.

## Task 5 — redesign the fixture generator: DFS, and far fewer fixtures

`scripts/generatePipelinePaths.ts` currently does breadth-first mutation search
and emits 700 fixtures. The user does not want 700.

Two changes:

**Switch BFS to DFS.** Line 246 is `queue.shift()` — FIFO. Use `queue.pop()`, or
an explicit stack, so one complete end-to-end path is discovered fully before
the next path is computed. Breadth-first currently spreads across shallow
mutations of every field at once, which is why deep paths never finish before
the cap.

**Emit a curated endpoint set, not an exhaustive sweep.** Cover the meaningful
endpoints of the diagrams, one fixture each. The user named these explicitly:

- end-to-end successful merge of the worktree
- codex amends the plan
- codex scraps the plan
- task tests pass
- task tests do not pass
- codex accepts the tests
- codex rejects (flags) the tests
- rebase succeeds
- rebase fails

and the list was open-ended, so also cover the remaining exit types the tracer
can reach. The full set, from `EXIT_TYPES` in the generator:

```
AGENT-FAILED  CLARIFY-STUCK  PLAN-SCRAPPED  TESTS-RED  TESTS-FLAGGED
RUN-FAILED  REBASE-STUCK  SUITE-RED  FENCE-VIOLATION  PARTIALLY-PUBLISHED
MERGE-FAILED  plus the completed (merge succeeded) path
```

Plus one `AGENT-FAILED` fixture per agent box, so all ten error edges are
exercised — that is what the `AGENT_BOXES` bug fix above unlocks.

Keep these properties of the current generator, they are good and were verified:
- the padding + tracking-`Proxy` trick that makes the true read-depth visible
  (`attempt()` clamps with `Math.min(index, len-1)`, so an unpadded array hides
  how far the tracer wanted to read)
- the trim step, and its verification that the trimmed fixture reproduces the
  original trace byte-for-byte, throwing if not
- deterministic output sorted by name, so re-running is byte-reproducible
- no `Math.random`, no `Date.now`

`tests/workflowMatchesTracer.test.ts` generates one test per fixture and must
stay green after regeneration. If a fixture makes the tracer and the workflow
disagree, that is a REAL divergence — report it, do not drop the fixture and do
not edit the workflow to match.

## Traps that cost this session real time

- `banner()` bypasses `push()`, so banner lines are NEVER indented at any depth.
- A run that exits from inside a loop ends on an INDENTED `stop` line.
- Counters are read BEFORE they increment, and count fix attempts spent, not
  rounds elapsed. `testsFlagged: [true, true]` runs THREE review rounds:
  round 1 `NO` amend, round 2 `NO` amend, round 3 `YES` exit.
- Do not hand-compose expected trace arrays. Generate them:
  `npx tsx scripts/tracePipeline.ts --list`, then
  `npx tsx scripts/tracePipeline.ts <name>`. Read the output, confirm it against
  the tracer source, paste it in.
- A comment-length hook blocks edits until comments are one line under 20 words.
- The repo rule: when a change breaks a test, that test is obsolete. Delete or
  update it. Never add code whose purpose is to keep an old test green.
