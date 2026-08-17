# Handoff: make emitPipelineOutput.ts emit the real skill body for path N, one pipeline box at a time
Conversation name: correct workflow 6
JSONL: /Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/ba448bd8-8ff5-47ec-9caa-dce2c5c23716.jsonl
Plan file: none — this session worked from plans/diagram/*.mmd directly

## Branch
`fix-tackle-tasks-workflow-script-imports` based on `master`

## Goal

`skills/tackle-tasks/SKILL.md` gets its body from `scripts/tackle-tasks/SkillBodyEmitter.ts`. That
body is the governing prompt: it is what the main agent reads and obeys to run a whole tackle-tasks
run. The end state is that `SkillBodyEmitter.skillBody()` emits the complete, correct prompt for
whichever path through the pipeline the current repository state puts the run on.

`scripts/tackle-tasks/emitPipelineOutput.ts` is the harness that proves it. For a given path it
writes `plans/diagram/output renders/pipeline-output-<N>.md`, holding two halves: the box-by-box
trace of that path, and the skill body actually emitted for it. `<N>` is the 1-based position of the
matching fixture in `scripts/tracePipelinePaths.json`. Today the second half is a one-line stub. The
work is to replace that stub with the real prompt, box by box, and to check each one by eye against
the trace printed above it.

The pipeline has 459 walkable paths. Stepping every one by hand is not viable, so this session built
`scripts/tackle-tasks/stepPipeline.ts`: walk a path by answering one keypress per decision box, get a
replay string back, and re-run that exact path later without typing. That is the loop the next
session should live in — walk a path, look at what the body emitted, fix the emitter, replay the same
sequence to confirm.

## Current State

Everything below is committed on `fix-tackle-tasks-workflow-script-imports` (HEAD `3f4e850`). The
working tree is clean except `plans/task-163-plan.md` and `scripts/tackle-tasks/.gitignore`, neither
of which belongs to this work.

**The preamble runs for real and is finished.** `runPreamble()` in
`scripts/tackle-tasks/PreambleDataEmitter.ts` walks: is the task number valid -> is the task blocked
-> is the task active -> does a worktree exist -> (no) create worktree, generate docs, init
submodules / (yes) is the worktree safe -> receipt -> is the receipt structure valid. Invoking the
skill really does mark the task active and really does create a `task-N` worktree, branch and lease.
The unsafe-worktree branch is still commented out on purpose and stops at
`IS_PREVIOUS_RUN_RESUMABLE`; `isTaskRunResumable` and `resetTaskWorktree` are the two calls left
commented.

**The emitted body is still only a stub.** `skillBody()` returns exactly one line:
`Say: 'stopped at <label>'` on success, or `Say: '<taskNumber> <reason>'` on a stop. The retired
v1.5 body sits below it inside a `/* */` block, ready to be restored box by box. Despite what you
may be told, the planning prompt is NOT yet wired into the body.

**But every agent prompt is already written.** `scripts/tackle-tasks/AgentPromptEmitter.ts` already
exports `planPrompt`, `reviewPlanPrompt`, `reviewTestsPrompt`, `implementPrompt`,
`fixConflictsPrompt`, `fixSuitePrompt`, `fixTestsPrompt`, `amendTestsPrompt` and
`codexReviewInstructions`. Wiring, not authoring, is the remaining job for the agent boxes.

**The diagrams no longer describe receipts.** All 35 `Receipt: { ... }` and 8 `Input: { ... }` box
labels across the six `.mmd` files were blanked to `Receipt: { }` / `Input: { }`. The diagrams are
still the source of truth for FLOW and WORDING, but no longer for receipt CONTENTS.

**Receipt shapes now live in code, next to the box that uses them.** Eleven types across eleven
files — see Key Files. The convention the user set: an agent box's receipt lives in that box's
`<Role>BodyEmitter.ts`; a receipt emitted at the END of a sub-pipeline lives in that sub-pipeline's
`<Name>PipelineEmitter.ts`.

**Agent boxes can now lose their result.** Each of the 8 orange boxes gained a
`did the agent return a result?` diamond and a `retry the box` node in the diagrams.
`PipelineDecisions` gained one optional field:

    agentReturnsResult?: Partial<Record<AgentBoxName, boolean[]>>

one boolean per VISIT to that box; absent or short means the agent returned. `tracePipeline.ts` has
an `agentBox()` helper that walks it, `tackle-tasks.workflow.js` mirrors it inside the shared `run()`
helper, and `generatePipelinePaths.ts` interprets the new markers.

**The stepper works.** `node scripts/tackle-tasks/stepPipeline.ts <taskNumber> [--replay <sequence>]
[--malformed <receipt>]`. One keypress per decision, prompt wording read from the diagram via `L()`,
prints the trace and then `use sequence <keys> to replay`. Keys: `y`/`n` for yes-no, `a`/`m`/`s` for
the review verdict, `o`/`c` for rebase, `f`/`c` for rebase advance, `r`/`0` for an agent box
(receipt / null). It touches no repository — it drives `tracePipeline.ts` only.

A known-good happy path: `node scripts/tackle-tasks/stepPipeline.ts 42 --replay ynnnrrarnrnyyofyyy`

**Tests.** `npm test` is 2082 tests, 2049 pass, 33 fail. All 33 failures are pre-existing quarantine
damage, unchanged by this work: 26 `test_workflow_*` dying on "real mode not implemented yet", 4
`test_resolveWorkflow_*`, 2 "skills/tackle-tasks holds only the current workflow files", and
`tests/tackle-tasks_bootstrap.workflow.test.ts`. They come from an earlier session moving
`blockers`/`bootstrap`/`resolve.workflow.js` into `skills/tackle-tasks/failed/`. Do not chase them.
`npx tsc --noEmit` is clean.

## What Remains

1. Decide whether to regenerate `scripts/tracePipelinePaths.json`. `node
   scripts/generatePipelinePaths.ts` now produces 459 fixtures instead of 128, and the first 128 keys
   come out byte-identical and in the same order, so existing `pipeline-output-<N>.md` numbering is
   preserved. Until you regenerate, any path the stepper walks that goes through an agent-null retry
   will make `emitPipelineOutput.matchPathNumber()` throw "the workflow block matches no known
   fixture". The user has NOT yet approved regenerating it; ask before you write that file.

2. Wire the planning boxes into `skillBody()`. Restore the `plan the task` box from the `/* */` block
   in `SkillBodyEmitter.ts`, calling `planPrompt()` from `AgentPromptEmitter.ts`. Follow the exact
   four-line box shape the user dictated and rejected two alternatives for:

       const activeCheck = isTaskActive(taskNumber, runId, projectRoot);
       if (activeCheck.status !== "claimed") {
           return { code: WorkflowResultCodes.DO_NOT_PROCEED, reason: activeCheck.reason, step: "IS_TASK_ACTIVE" };
       }

   Call the check function directly. No `execFileSync` wrapper, no `runCheck<T>` generic, no `stop()`
   helper. Each check words its own `reason` inside the check script, never in the caller.

3. Then `codex reviews the plan`, using `reviewPlanPrompt()`, plus the
   `what is the review verdict?` decision and its accept / amend / scrap edges.

4. Then the implement-and-test boxes, then rebase-and-merge, then the exit workflow — in diagram
   order, one box at a time, checking each against `pipeline-output-<N>.md` before moving on.

5. Uncomment `isTaskRunResumable` and `resetTaskWorktree` in `PreambleDataEmitter.ts` to finish the
   unsafe-worktree branch, whenever the user wants that branch live.

## Key Files

- `scripts/tackle-tasks/SkillBodyEmitter.ts` — emits the governing prompt. The stub to replace is
  the single `return \`Say: 'stopped at ...'\`` line; the retired v1.5 body is in the `/* */` below it.
- `scripts/tackle-tasks/PreambleDataEmitter.ts` — `runPreamble()`, the finished preamble walk.
- `scripts/tackle-tasks/AgentPromptEmitter.ts` — all 8 agent prompts, already written.
- `scripts/tackle-tasks/emitPipelineOutput.ts` — the harness; `--path` stages real on-disk state.
- `scripts/tackle-tasks/stepPipeline.ts` — the stepper built this session.
- `scripts/tracePipeline.ts` — the diagrams made runnable. `L(id)`, `PipelineDecisions`, `agentBox()`.
- `scripts/generatePipelinePaths.ts` — derives fixtures from diagram walks.
- `skills/tackle-tasks/tackle-tasks.workflow.js` — must print byte-identical lines to the tracer.
- `plans/diagram/*.mmd` — the source of truth for flow and wording.
- Receipt shapes: `PlannerBodyEmitter.ts` (`PlanFileReceipt`), `CodexReviewBodyEmitter.ts`,
  `CodexTestReviewBodyEmitter.ts`, `AmendTestsBodyEmitter.ts`, `FixCodebaseBodyEmitter.ts`,
  `FixConflictsBodyEmitter.ts`, `SuiteFixBodyEmitter.ts`, `PlanningPipelineEmitter.ts`,
  `ImplementTestPipelineEmitter.ts`, `RebaseMergePipelineEmitter.ts`,
  `validateActiveTaskReceipt.ts` — all under `scripts/tackle-tasks/`.

## Context the Next Agent Won't Have

- **`PlannerBodyEmitter.ts` is NOT the planning box.** It already existed and holds a RETIRED earlier
  design of the preamble, still calling `claimTask`. Only `PlanFileReceipt` at its top is current.
  This session overwrote that file by accident and had to restore it from git. Read a file before you
  write it, even when the name suggests it is new.
- **Read `~/.claude/CLAUDE.md`, especially "Small changes stay small".** The user added it because an
  earlier session over-engineered repeatedly. Do not add a parameter, field, branch, enum case,
  helper, generic, try/catch or fallback that was not asked for. If a change breaks a test, that test
  is obsolete — delete or update it, never add code to keep it green. Repeat lines instead of
  extracting a helper.
- **"Don't program for the fog of war."** Direct user instruction this session. Only handle problems
  actually observed. This is why an agent box that loses its result twice has NO gate and NO exit box,
  unlike every other retry loop in the diagrams — nobody has hit that case, so it is not modelled.
- **`WorkflowResultCodes` has exactly two codes**, `PROCEED` and `DO_NOT_PROCEED`. Do not add a third.
- **Comment style is enforced by a hook.** Every `//` comment must be one line and under 20 words, or
  the `.plate` Stop hook blocks you. It also reflows consecutive `//` lines into one long line, which
  is why the retired body uses `/* */`. Expect the hook to rewrite comments in any file you touch, so
  your diffs will look larger than your actual edits.
- **The `.plate` Stop hook runs tests mid-edit and its results can be STALE.** It can run a
  half-finished test file against the real repo and strand a task active. After any test run check
  `jq '[.[] | select(.run.active == true) | .taskNumber]' .taskTools/tasks.json` and
  `git checkout -- .taskTools/tasks.json` if it is not empty.
- **Use `npm test`, never `bun test`.** bun reports a false failure in mergeTaskWorktrees.
- **Always pass a throwaway projectRoot to `emitPipelineOutput.ts` while iterating.** Running it
  against the real repo marks a real task active, and nothing marks it inactive again, because
  `markTaskInactive` and the exit workflow are not wired into `runPreamble` yet. This stranded task 35
  twice in one day.
- **Stale lease files block a task forever.** In `$TMPDIR/taskTools-wt/<repo>-<hash>/`,
  `createTaskWorktree` correctly refuses a worktree whose lease names another run, even a long-dead
  one. If you see "refusing to touch it", check the lease owner's pid with `ps` before deleting.
- **`generatePipelinePaths.ts` does `{ ...originals, ...generated }`** and never drops an original
  whose diagram path is gone, so regenerating silently keeps dead fixtures.
- **Another session commits into this repo while you work.** ~30 untracked `plans/*.md` files belong
  to other sessions. Stage explicit paths only, never `git add -A`.
- **A new file passes the git-grep hygiene tests while untracked and fails once staged.** Re-run the
  suite after `git add`.
- **`tests/tracePipeline.test.ts` pins traces literally.** Adding a line to the tracer means editing
  every pinned trace. `AGENT_RETURNED` and `RECEIPT` at the top are the shared constants for that.
- **The stepper memoizes every answer.** `traceTaskPipeline` reads each decision field more than once
  per box, so without memoization one box asks twice and the walk desynchronises. This was found and
  fixed; do not remove the `once()` / `answered` maps.

## How to Verify

    cd /Users/matkatmusicllc/Programming/taskTools-86
    npx tsc --noEmit                                    # must be silent
    npm test 2>&1 | rg '^ℹ (tests|pass|fail)' | tail -3 # expect 2082 / 2049 / 33

Confirm the 33 failures are only the known groups:

    npm test 2>&1 | rg '^✖ test_' | sort -u | rg -v 'test_workflow_|test_resolveWorkflow_|holds only the current workflow|bootstrap'

That must print nothing. Then check nothing was stranded:

    jq '[.[] | select(.run.active == true) | .taskNumber]' .taskTools/tasks.json   # expect []

Walk a path and replay it:

    node scripts/tackle-tasks/stepPipeline.ts 42
    node scripts/tackle-tasks/stepPipeline.ts 42 --replay ynnnrrarnrnyyofyyy
