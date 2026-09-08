# Task 151 plan — merge stage calls the submodule-then-parent primitive across all layers

## Goal

Wire the `merge` stage of `skills/tackle-tasks/task.workflow.js` (function `runMerge`) to call the
existing per-task merge primitive `mergeTaskDeepestFirst`, exported from
`scripts/mergeTaskWorktrees.ts`. This task merges only — it does not close the task and does not
call `removeWorktreeAndBranch`.

## Which primitive is "the primitive"

`scripts/mergeTaskWorktrees.ts` exports `mergeTaskDeepestFirst(worktreePath, manifest,
mergeStepOperations = defaultMergeStepOperations)` (defined at line 506). Reading its body:

- It orders occurrences as `[...submoduleOccurrencesDeepestFirst, rootOccurrence]` (line 524) —
  submodules deepest-first, then the parent (root) last — matching the brief's "(a) each
  submodule's task-N branch merges into that submodule's own source branch, deepest layer first
  ... then (b) the parent's task-N branch merges into the parent's source branch."
- For each submodule occurrence it rebases+tests (`rebaseAndTestSubmoduleLayer`), then merges via
  `mergeStepOperations.mergeSubmodule`, which defaults to `mergeSubmoduleBranchIntoRepo` (line 450:
  `mergeSubmodule: mergeSubmoduleBranchIntoRepo`).
- Before each occurrence's own work it calls `propagateChildGitlinks` (line 553), which checks out
  each already-merged child's new source tip and stages/commits the gitlink bump in the parent
  occurrence — this is "each containing repository's gitlink is resolved to the just-merged commit,
  propagating up the chain" from the brief.
- For the root occurrence it rebases+tests (`rebaseParentOntoSourceAndTest`) then merges via
  `mergeStepOperations.mergeGroup`, which defaults to `mergeGroupBranchIntoRepo` (line 451:
  `mergeGroup: mergeGroupBranchIntoRepo`).
- Its return type `MergeTaskWalkReport` (lines 462-480) already has three variants —
  `"merged"`, `"submodule-conflicted"`, `"parent-conflicted"` — which is already the "discrete
  outcome distinguishing a submodule-layer failure from a parent-layer failure" the brief's
  FAILURE CONTRACT asks for. No new failure-shaping code is needed in the workflow; the primitive's
  own return value already carries that distinction.

This confirms `mergeTaskDeepestFirst` is the tasks 142-144 primitive: it performs the exact ordered
lap described in the brief, using the exact two named functions (`mergeSubmoduleBranchIntoRepo`,
`mergeGroupBranchIntoRepo`) the brief calls out as "not one function parameterised by layer." The
workflow's job is to call this one function, not to re-walk occurrences itself.

## Edits

### `skills/tackle-tasks/task.workflow.js`

Current text, lines 670-678:

```
const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = process.cwd()
  const { execFileSync } = await import('node:child_process')
  const { existsSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  return { stage: 'merge', task: N }
}
```

Replace with:

```
const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = process.cwd()
  const { execFileSync } = await import('node:child_process')
  const { existsSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { mergeTaskDeepestFirst } = await import('./scripts/mergeTaskWorktrees.ts')
  const { createEmptyResolutionManifest } = await import('./scripts/resolutionRequests.ts')
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  const manifest = { repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }
  const { stage: failedAtStage, ...report } = mergeTaskDeepestFirst(repoRoot, manifest)
  return { stage: 'merge', task: N, failedAtStage, ...report }
}
```

Rationale for each changed/added line:

- Two new dynamic imports (`mergeTaskDeepestFirst`, `createEmptyResolutionManifest`) added right
  after the three existing imports, matching the exact import style and specifiers `runRebaseTest`
  already uses at lines 554-555 for the same two symbols (`./scripts/mergeTaskWorktrees.ts` and
  `./scripts/resolutionRequests.ts`), so both imports are already proven to resolve correctly in
  this file.
- `cleanupPlanAndBriefFiles(...)` call is unchanged and keeps its position first — spec item 6's
  order is "delete plan + brief ... merge ... run closeTasks.ts ... removeWorktreeAndBranch last,"
  so cleanup precedes merge.
- `manifest` is built the same way `runRebaseTest` builds it at line 557
  (`{ repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }`),
  reusing the same `ARGS.repositoryManifest` the workflow already receives for the `rebase-test`
  stage's call into the same source file.
- `mergeTaskDeepestFirst(repoRoot, manifest)` is the one call that performs the entire ordered lap
  (submodules deepest-first, then parent) — no per-layer loop is written here, satisfying "the
  ordering is NOT reimplemented here."
- The destructure `const { stage: failedAtStage, ...report } = mergeTaskDeepestFirst(...)` is
  needed because `MergeTaskWalkReport`'s failure variants carry their own `stage: "rebase" |
  "test" | "merge"` field (scripts/mergeTaskWorktrees.ts lines 469 and 477) naming which internal
  step failed. Spreading the report directly into `{ stage: 'merge', task: N, ...report }` would
  let that inner `stage` value silently overwrite the outer `stage: 'merge'` workflow-stage marker
  on any failure, which every other stage runner in this file (`plan`, `implement`,
  `rebase-test`) sets and keeps intact. Renaming it to `failedAtStage` on the way out keeps both
  values: the outer `stage: 'merge'` identifies which workflow stage ran, and `failedAtStage`
  (undefined on success, `"rebase" | "test" | "merge"` on a submodule/parent conflict) preserves
  the primitive's own diagnosis for task 149 to report.
- The returned object always carries `status` (`"merged" | "submodule-conflicted" |
  "parent-conflicted"`) from the spread `report`, plus `completedLayers`, and on failure
  `occurrenceId` (submodule case only), `checkoutPath`, `conflictedFilePaths`, and
  `failureReason` — the complete discrete outcome the FAILURE CONTRACT asks for, taken verbatim
  from the primitive rather than re-derived.

No other line in `runMerge`, and no other function in this file, needs to change. `STAGE_RUNNERS.merge`
(line 684: `merge: async () => [await runMerge()],`) already calls `runMerge` and needs no edit — it
just forwards whatever `runMerge` now returns.

The phase label at line 16 (`{ title: \`${N} Merge\`, detail: 'merge and close the task' }`) is left
unchanged. It describes the `merge` *stage* as a whole, which — per `plans/task-86-spec.md`'s stage
table ("`merge` | cleanup, merge, close | serial tail") — includes closing once task 152 adds that
call to the same stage. This task implements only the merge portion of that stage; the label already
describes the stage's eventual full behavior and does not need correcting.

### `scripts/mergeTaskWorktrees.ts`

No edit. `mergeTaskDeepestFirst` (lines 506-609) already:

- orders submodule occurrences deepest-first then the parent last (line 521-524),
- propagates each merged child's new gitlink into its parent before that parent's own rebase/merge
  (line 553, `propagateChildGitlinks`, called for every occurrence including the root),
- calls `fetchBaseBranchFromSource`-equivalent submodule sync inside `rebaseAndTestSubmoduleLayer`
  (line 266, `fetchBaseBranchFromSource`) for every submodule occurrence, satisfying "an explicit
  `git fetch` because a submodule inside a worktree is a separate checkout,"
- uses `mergeGroupBranchIntoRepo` (line 383, no fetch) for the parent step, matching "does not
  [fetch], since a parent worktree shares the root repo's object store,"
- returns a discrete `"submodule-conflicted"` vs `"parent-conflicted"` outcome (lines 464-480).

No layer is missing from this walk (submodule rebase, submodule test, submodule merge, gitlink
propagation, parent rebase, parent test, parent merge are all present in the loop body at lines
542-606), so the brief's escape hatch ("if the primitive turns out to be missing a layer, fix it
here") is not triggered — there is nothing to fix.

### `plans/task-86-spec.md`

No edit. This file is the agreed design document this task must follow; the brief does not ask for
any change to it, and nothing in the brief or the split-task description requests updating the spec
text.

## Verification

Run from the repo root `/Users/matkatmusicllc/Programming/taskTools-86`:

1. `node --check skills/tackle-tasks/task.workflow.js`
   Expected: exits 0, no output. (This file runs inside a harness that supplies `args`, `agent`,
   and `log` as ambient bindings, so it cannot be executed standalone — `--check` parses it for
   syntax validity only, which is what this edit can break.)

2. `rg -n "mergeTaskDeepestFirst" skills/tackle-tasks/task.workflow.js`
   Expected: two lines — the import line and the call line inside `runMerge`.

3. `rg -n "^export function mergeTaskDeepestFirst" scripts/mergeTaskWorktrees.ts`
   Expected: one match, confirming the imported symbol is exported from the file the workflow
   imports it from.

4. `rg -n "createEmptyResolutionManifest" skills/tackle-tasks/task.workflow.js`
   Expected: four lines total — two existing ones inside `runRebaseTest` (already present before
   this edit) and two new ones inside `runMerge` (the import and the `manifest` construction),
   confirming the new call reuses the exact same import specifier already proven to resolve in
   this file.

5. `git diff -- skills/tackle-tasks/task.workflow.js`
   Expected: the diff touches only the `runMerge` function body, matching the "Current text" /
   "Replace with" blocks above exactly, and no other line in the file changes.
