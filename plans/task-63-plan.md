# Task 63 plan (shipped): judgeMergeRun must not report "merged" when nothing was published

## Root cause (brief question 1)

`mergePipeline.ts` sets `runState.status = "approved"` as soon as
`readyForApproval` is true, and nothing downstream ever downgrades it. When
`runFinalization`'s base-drift check aborts (the source branch moved past the
pinned `baseOid`), the abort path still prints the pre-approval `conflicts`
array — empty, because the drift is not a textual conflict — together with the
stale `"approved"` runState and an empty `publicationTargets`.

`judgeMergeRun` in `scripts/runMergePhase.ts` only checked `exitCode`, JSON
parseability, and `conflicts.length`. All three passed, so it returned
`"merged"` for a run that published nothing, and the orchestrator then archived
the tasks via `close-tasks`.

## Design (brief question 2)

Report `blocked`. The empty `publicationTargets` array is the one unambiguous,
already-emitted signal that nothing reached the source branch, and
`MergePhaseVerdict.status` has no third state. A successful run always publishes
at least the root occurrence, so this can never fire on a genuinely merged run.

Automatic rebase-then-retest-then-retry was considered and rejected for this
task: codex found the retry orchestration under-specified (stale operation
branches, rebase-state path handling in linked worktrees, no end-to-end retry
test). It is filed as its own task.

## Edits (both applied)

`scripts/runMergePhase.ts` — widen the parsed-output type with
`publicationTargets?: unknown[]`, and insert one guard between the `conflicts`
check and the final `return { status: "merged", ... }`:

```ts
if ((output.publicationTargets?.length ?? 0) === 0)
    return blocked("merge script exited clean but published nothing (publicationTargets is empty): the run was not ready for approval, or the source branch moved past its pinned baseOid before publish", [], output);
```

`tests/runMergePhase.test.ts` — the merged-path fixture now includes a
non-empty `publicationTargets` (it previously described a state the pipeline
never emits), plus one new test
`test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButPublishedNothing`
asserting the exact scenario from the brief.

## Verification

`npx tsc --noEmit` clean; `node --test tests/runMergePhase.test.ts` 7/7 pass.
