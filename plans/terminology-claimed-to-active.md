# Terminology: "claimed" is retired, the word is "active"

Decided 2026-08-14, while redrawing `plans/diagram/pipeline.mmd`.

## Why

"Claim" implied a pool of idle agents picking up work they then own. That is not what
happens. A task is **marked active**, a worktree is created, agents work in that worktree,
the worktree is merged back, and the task is **marked inactive**. Nothing is owned.

## Done

- `plans/diagram/pipeline.mmd` and `plans/diagram/pipeline-preamble.mmd`
  - the rectangle `MARK["claim the task: mark it active in tasks.json"]` became the diamond
    `QA{"is the task active?"}` plus the rectangle `MARK["mark the task active in tasks.json"]`
  - header rules reworded: no "claim held", no "unclaimable", no "before the claim"
  - rule 12 now records that the diamond and the rectangle are **one atomic read-modify-write**
    of tasks.json — two shapes, not two writes, so there is no window between them
- `scripts/tracePipeline.ts` — decision field `claim: "claimed" | "refused"` became
  `taskActive: boolean`; the trace prints `TASK ACTIVE: NO` then `MARK THE TASK ACTIVE`
- `scripts/tracePipelinePaths.json` — fixture `already-claimed` renamed `already-active`
- `tests/tracePipeline.test.ts` — expectations and test names follow

## Not done — deliberately deferred

These still say "claim". They carry their own tests and reconciler wiring, so renaming them
is a separate job:

| Where | Symbol |
|---|---|
| `scripts/tackle-tasks/taskRunState.ts` | `claimTask`, `ClaimOutcome`, `status: "claimed"` |
| `scripts/tackle-tasks/reconcileStep.ts` | `claimTaskRun` handler |
| `scripts/tackle-tasks/greenBoxPolicy.ts` | `claimTaskRun` entry |
| `scripts/tackle-tasks/PlannerBodyEmitter.ts` | `claimTaskNumber`, `ClaimedTask` |

The exit type `already-active` was already correct and did not change.

## Rule going forward

New code, diagrams and prose say **active** / **inactive**. Do not reintroduce "claim",
"claimed", "unclaimed" or "claim refused".
