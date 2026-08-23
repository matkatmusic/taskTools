# Loop-based workflow

The idea, not a plan.

## The problem

The pipeline's shape is written down four times:

| Where | Size | What it holds |
|---|---|---|
| `plans/diagram/*.mmd` | — | the shape, as pictures |
| `scripts/tackle-tasks/pipelines.ts` | 35 KB | the shape, as code |
| `skills/tackle-tasks/tackle-tasks.workflow.js` | 45 KB | the same shape, generated from the above |
| `scripts/tackle-tasks/reconcileStep.ts` | 43 KB | what to do when a step's result is lost |

One truth, four copies. 
Adding a box means editing several of them in step. Marking a box
`mutating` costs three separate edits. 
The generated workflow must never be hand-edited, so a change always starts somewhere other than where the symptom appears.

## The idea

The `.mmd` files already are the lookup table for "what runs next". 
Use them as the table instead of re-encoding them.

The hook takes one step, runs it, and returns the next step:

```ts
thisStep = /* arg from CLI */;
result = null;
while (true) {
    result = executeThe(thisStep);
    if (taskHasFinishedAndClosed(result) || stepExecutionFailed(result)) break;

    nextStep = getNextStepBasedOn(result);
    if (isAPrompt(nextStep)) break;          // an agent must run it, so the hook stops

    amendResultToNextStepInput(nextStep, result);
    thisStep = nextStep;
}
return result;
```

The workflow is the same loop, one level up. It spawns the agents that invoke the skill, which fires the hook:

```js
thisStep = runPreamble();
while (true) {
    result = await agent(thisStep);          // "invoke /run-step <thisStep>"
    if (result.stepResult == STEP.taskClosed) break;
    thisStep = amendResultToNextStepInput(nextStep, result);
}
```

Each hook call does exactly one of three things:

- returns the prompt the agent should follow,
- runs a script, or
- returns the output object the agent hands back to the workflow.

## Why it is worth doing

- **One place to put a breakpoint.** Every routing decision becomes `getNextStepBasedOn`. Today a
  decision may live in `pipelines.ts`, in the generated workflow, or in `reconcileStep`.
- **The run log becomes the whole trace.** One loop turn is one block in `run-log.md`. Reading the
  file top to bottom replays the run. Today the trace is split between workflow `log()` lines and
  step receipts in `tasks.json`.
- **A stuck run has an address.** "It stopped at `COMMIT_IMPLEMENTATION_IF_NEEDED`" is a resumable fact.
- **The graph is testable without running anything.** Walk every path with fake receipts: no
  agents, no worktrees, no git.
- **The generated workflow mostly disappears.** A `while` loop calling `/run-step` needs no
  generator.

## What fought it, and is now fixed

The diagrams were not a clean lookup table: four node ids were reused across files, so one id
could imply several different "next steps".

| Node | Was in | Now |
|---|---|---|
| `COMMIT_IF_NEEDED` | 3 diagrams, 3 different successors | `COMMIT_IMPLEMENTATION_IF_NEEDED`, `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED`, `COMMIT_SUITE_FIX_IF_NEEDED` |
| `READ_PUBLICATION_STATE` | 2 diagrams, 2 different successors | `READ_MERGE_PUBLICATION_STATE`, `READ_FAILURES_PUBLICATION_STATE` |
| `EXIT_WORKFLOW` | 9 diagrams, no successors | one id per pipeline, e.g. `EXIT_WORKFLOW_IMPLEMENT` |
| `TASK_NUMBER_INPUT` | 2 diagrams, no successors | `TASK_NUMBER_INPUT`, `PREAMBLE_TASK_NUMBER_INPUT` |

Every node id is now unique, so "what runs next" is a plain lookup with no exceptions. The
remaining multi-successor nodes are honest decision diamonds — `WHAT_IS_REVIEW_VERDICT`,
`WHAT_IS_PUBLICATION_STATE`, `WHAT_DID_THE_PLANNER_RETURN` — where the receipt names the branch.

## Where to start

Retire the current workflow before writing the new one. 
Do these three things first, in this order:

1. Rename `skills/tackle-tasks/tackle-tasks.workflow.js` to `tackle-tasks.workflow_old.js`.
2. Rename `scripts/tackle-tasks/tackle-tasks.workflow.template.js` to `tackle-tasks.workflow_old.template.js`.
3. Write a new `scripts/tackle-tasks/tackle-tasks.workflow.template.js` holding the loop design above.

This keeps the current generated workflow on disk, so nothing is lost and the old routing stays
readable while the new one is built. 
It also takes the old file out of the skill's active code path, so
nothing loads it by accident and no half-migrated run picks it up.

The generator writes to whatever `tackle-tasks.workflow.js` names, so step 1 must happen before the
generator runs again. 
Otherwise the next regeneration overwrites the copy you meant to keep.

## Existing pieces to build on

- `scripts/mmdGraph.ts` already parses the diagrams into `pipelineGraph` and `nodeLabels`.
- `scripts/runStepHook.ts` already holds `STEP_TABLE`, keyed by diagram box id.
- `greenBoxPolicy.ts` already classifies every dispatched script.
