# Task 167 plan: one branch identity end to end (C86-02)

## Root cause (confirmed by reading the owned files)

`prepareTasks.ts`'s `createWorktreeForGroup` creates the real worktree branch by calling
`branchNameForGroup(group.groupId)` (returns `` `task-${groupId}` ``) and then
`createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchName)` —
this creates **the same branch name** (`task-<groupId>`) in the worktree's root repo and in
every submodule. So for one task's worktree, every occurrence (root and submodules alike)
really is checked out on the identical branch name `task-<groupId>`.

But in `runAsCli` (`prepareTasks.ts` lines 217-221 as currently on disk):
```
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const runId = generateRunId();
    const manifest = loadRepositoryManifest(repoRoot);
    manifest.occurrences = buildOperationPushOccurrences(manifest.occurrences, runId);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, tasks);
```
`manifest.occurrences` gets its `operationBranch` field overwritten by
`buildOperationPushOccurrences` (`operationBranches.ts`), which sets it to
`` `operations/${runId}/${sanitizeSegment(logicalId)}` `` — a name derived from `runId` and a
hash of the occurrence's origin-URL identity, unrelated to `task-<groupId>` and never created by
`createBranchInEveryRepository`. This manifest is exactly what `runAsCli` embeds into
`pipelineArguments.repositoryManifest` and prints/writes to `run-arguments.json`.

`skills/tackle-tasks/task.workflow.js` takes that manifest unchanged: both `runRebaseTest` and
`runMerge` build `{ repositoryManifest: ARGS.repositoryManifest, ... }` and hand it to
`rebaseSubmoduleLayersDeepestFirst` / `mergeTaskDeepestFirst` (`mergeTaskWorktrees.ts`). Those
functions read `occurrence.operationBranch` to `git fetch` and `git rev-list`/`merge` against
(e.g. `mergeTaskWorktrees.ts` lines 532-534, 570, 598). Since the real worktree branch is
`task-<groupId>` but `occurrence.operationBranch` says `operations/<runId>/<hash>`, those git
calls target a ref that was never created.

`operationBranches.ts`'s `operationBranchName`/`setUpOperationBranches` functions (the
`operations/<runId>/<occurrenceId>` scheme) are a *different* naming function, not the one
implicated here, and per the brief task 165 (not a blocker for this task) is doing separate,
deliberately-unrelated work on that `operations/<runId>/...` scheme. `buildOperationPushOccurrences`
is only called from the one site in `prepareTasks.ts` identified above (confirmed by reading the
whole of `operationBranches.ts` and the whole of `prepareTasks.ts`); nothing else in the owned
files calls it, so removing that one call site does not touch the `operations/<runId>/...` scheme
task 165 is working on — `operationBranches.ts` needs no edit here.

`mergeTaskWorktrees.ts` already consumes `occurrence.operationBranch` correctly (it just needs the
manifest handed to it to actually name the branch that exists) — no edit needed there.

**Why the fix cannot bake one branch name into `prepareTasks.ts`'s manifest.** `runAsCli` builds
**one** `repositoryManifest` for the whole run and embeds it once in `pipelineArguments`
(`repositoryManifest: manifest`). `scripts/tackleTasksBrief.ts` (not an owned file, read for
context only) launches `task.workflow.js` once **per task** with args
`{task: taskNumber, stage, repositoryManifest, worktree}` — every launch receives the **same**
`repositoryManifest` object but a **different** `worktree` (the `groups` entry whose
`tasks[0].number === taskNumber`). Each task's worktree is checked out on its own
`task-<taskNumber>` branch (`branchNameForGroup` keyed by `groupId`, and
`buildWorkflowArguments` sets `groupId: task.taskNumber`, i.e. one group per task, one branch per
task). So whenever a run tackles more than one task at once, no single `operationBranch` string
written into the shared manifest at prepare time can be correct for every task's invocation —
picking any one group's branch (e.g. the first) is only correct for that one task and wrong for
every other task in the same run. The manifest's `operationBranch` field must therefore be set
**per invocation**, inside `task.workflow.js`, from that invocation's own task number — not baked
in once by `prepareTasks.ts`.

## Fix

1. Stop `prepareTasks.ts` from writing the mismatched `operations/<runId>/<hash>` value into the
   manifest (delete the `buildOperationPushOccurrences` call). Export a small pure helper,
   `attachOperationBranch(occurrences, branch)`, that returns the occurrences with `operationBranch`
   set to `branch` on every one — `prepareTasks.ts` does not call it itself; it exists so
   `task.workflow.js` can call it once per invocation.
2. In `skills/tackle-tasks/task.workflow.js`, in both `runRebaseTest` and `runMerge`, before
   building the `manifest` object passed to `rebaseSubmoduleLayersDeepestFirst` /
   `mergeTaskDeepestFirst`, apply `attachOperationBranch(ARGS.repositoryManifest.occurrences,
   \`task-${N}\`)`. `N` is `ARGS.task`, already available in both functions, and
   `` `task-${N}` `` is exactly the branch `createWorktreeForGroup`/`branchNameForGroup` created
   for this task's worktree (`groupId === task.taskNumber`), computed fresh on every invocation —
   so it is correct regardless of how many tasks a run tackles or in what order, with no shared
   mutable state between invocations.

No edge case to guard: unlike the rejected first draft, this fix never indexes into `groups`, so
there is nothing to skip when `groups` is empty — `attachOperationBranch` only ever runs inside a
`task.workflow.js` invocation, which only happens for a task that already has a worktree.

## Edits

### scripts/prepareTasks.ts

**Edit 1** — add the `RepositoryOccurrence` type to the existing import (currently line 7):

Current:
```
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "./repositoryManifest.ts";
```
New:
```
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";
```

**Edit 2** — delete the now-unused import (currently line 11):

Current line to delete entirely:
```
import { buildOperationPushOccurrences } from "./operationBranches.ts";
```
(Delete the whole line; nothing replaces it — the following blank line and `export type
PreparedTask` block shift up by one line.)

**Edit 3** — add a new exported helper right after `branchNameForGroup` (currently lines 95-97):

Current:
```
function branchNameForGroup(groupId: number): string {
    return `task-${groupId}`;
}
```
New:
```
function branchNameForGroup(groupId: number): string {
    return `task-${groupId}`;
}

export function attachOperationBranch(occurrences: RepositoryOccurrence[], branch: string): RepositoryOccurrence[] {
    return occurrences.map((occurrence) => ({ ...occurrence, operationBranch: branch }));
}
```

**Edit 4** — stop rewriting the manifest with the mismatched name; leave `operationBranch` as
whatever `loadRepositoryManifest` set it to (each occurrence's `operationBranch` is now assigned
per task, inside `task.workflow.js`, not here) (currently lines 219-221):

Current:
```
    const manifest = loadRepositoryManifest(repoRoot);
    manifest.occurrences = buildOperationPushOccurrences(manifest.occurrences, runId);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, tasks);
```
New:
```
    const manifest = loadRepositoryManifest(repoRoot);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, tasks);
```
(Delete the middle line only; nothing replaces it.)

**Edit 5** — export `loadRepositoryManifest` so the production-shaped test can build its manifest
with the exact same function `runAsCli` uses, instead of hand-building an occurrence object
(currently line 185):

Current:
```
function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
```
New:
```
export function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
```
(Add the `export` keyword only; the body is unchanged.) After Edit 4, `loadRepositoryManifest` IS
the whole of `runAsCli`'s manifest construction, so a test calling it exercises the real
production path with no wrapper helper in between. Verified against a bare fixture repo with no
origin remote: `bootstrapRepositoryManifest` does not refuse, and it returns a single root
occurrence whose `operationBranch` is the empty string `''`. That empty value is what makes the
test meaningful — the merge stage cannot succeed unless `task.workflow.js` supplies the real
`task-<N>` branch itself.

No other edits to `scripts/prepareTasks.ts`. `runId` stays in place (still generated, still used
elsewhere in `pipelineArguments`); only its use for naming `operationBranch` is removed.
`attachOperationBranch` is exported from this file (Edit 3) but is not called from this file — it
is called from `skills/tackle-tasks/task.workflow.js` instead, once per task invocation (see
below), which is what makes the branch name correct for every task in a multi-task run instead of
only the first.

### scripts/operationBranches.ts

No edit. `buildOperationPushOccurrences`, `operationBranchName`, `setUpOperationBranches`,
`sanitizeSegment`, and `identityKey` all stay exactly as they are — they are not the functions
consumed by the buggy path once `prepareTasks.ts`'s one call site is removed, and per the brief
task 165 (explicitly not a blocker for this task) does separate work on the
`operations/<runId>/...` scheme these functions implement.

### scripts/mergeTaskWorktrees.ts

No edit. `mergeTaskDeepestFirst` and `rebaseSubmoduleLayersDeepestFirst` already read
`occurrence.operationBranch` generically and fetch/diff/merge against it; the bug was entirely in
what value `prepareTasks.ts` put into that field, not in how `mergeTaskWorktrees.ts` consumes it.

### skills/tackle-tasks/task.workflow.js

`runRebaseTest` and `runMerge` each build
`{ repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }`
and pass it straight to `rebaseSubmoduleLayersDeepestFirst` / `mergeTaskDeepestFirst`. Both
functions need to set `operationBranch` to this invocation's own `task-${N}` branch first, using
the helper exported from `prepareTasks.ts`.

**Edit 1** — in `runRebaseTest`, import `attachOperationBranch` alongside the existing dynamic
import of `mergeTaskWorktrees.ts`, and apply it before building `manifest` (currently lines 560-564
as quoted above from "Root cause"):

Current:
```
  const { rebaseSubmoduleLayersDeepestFirst, rebaseParentOntoSourceAndTest, uncommittedChangedFiles } = await import(pathToFileURL(join(WORKTREE, 'scripts/mergeTaskWorktrees.ts')).href)
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(WORKTREE, 'scripts/resolutionRequests.ts')).href)
  const worktreePath = preparedTask.repoRoot
  const manifest = { repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }
```
New:
```
  const { rebaseSubmoduleLayersDeepestFirst, rebaseParentOntoSourceAndTest, uncommittedChangedFiles } = await import(pathToFileURL(join(WORKTREE, 'scripts/mergeTaskWorktrees.ts')).href)
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(WORKTREE, 'scripts/resolutionRequests.ts')).href)
  const { attachOperationBranch } = await import(pathToFileURL(join(WORKTREE, 'scripts/prepareTasks.ts')).href)
  const worktreePath = preparedTask.repoRoot
  const manifest = { repositoryManifest: { ...ARGS.repositoryManifest, occurrences: attachOperationBranch(ARGS.repositoryManifest.occurrences, `task-${N}`) }, resolutionManifest: createEmptyResolutionManifest() }
```

**Edit 2** — in `runMerge`, same change, using `repoRoot` (which this function already sets to
`WORKTREE` at its top) for the dynamic import path (currently the lines quoted above from "Root
cause" around the existing imports of `resolutionRequests.ts` / `repositoryBranches.ts` /
`closeTasks.ts`):

Current:
```
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(repoRoot, 'scripts/resolutionRequests.ts')).href)
  const { currentBranchName } = await import(pathToFileURL(join(repoRoot, 'scripts/repositoryBranches.ts')).href)
  const { closeTasks } = await import(pathToFileURL(join(repoRoot, 'scripts/closeTasks.ts')).href)
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  const manifest = { repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }
```
New:
```
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(repoRoot, 'scripts/resolutionRequests.ts')).href)
  const { currentBranchName } = await import(pathToFileURL(join(repoRoot, 'scripts/repositoryBranches.ts')).href)
  const { closeTasks } = await import(pathToFileURL(join(repoRoot, 'scripts/closeTasks.ts')).href)
  const { attachOperationBranch } = await import(pathToFileURL(join(repoRoot, 'scripts/prepareTasks.ts')).href)
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  const manifest = { repositoryManifest: { ...ARGS.repositoryManifest, occurrences: attachOperationBranch(ARGS.repositoryManifest.occurrences, `task-${N}`) }, resolutionManifest: createEmptyResolutionManifest() }
```

No other edits to this file. Every downstream use in both functions already reads from `manifest`
(not `ARGS.repositoryManifest` directly), so nothing else needs to change: `occurrences =
manifest.repositoryManifest.occurrences` in `runRebaseTest`, and `rootOccurrence =
manifest.repositoryManifest.occurrences.find(...)` / `mergeTaskDeepestFirst(repoRoot, manifest)`
in `runMerge`, all now see the corrected `operationBranch`.

### tests/taskWorkflowMergeStage.test.ts

**Edit 1** — import the new helper (currently line 10):

Current:
```
import { createWorktreeForGroup } from '../scripts/prepareTasks.ts'
```
New:
```
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest } from '../scripts/prepareTasks.ts'
```

**Edit 2** — in the `'production-shaped: the worktree prepareTasks.createWorktreeForGroup
produces is what task.workflow.js merges, with no chdir and the real script path'` test, replace
the hand-built manifest with the real one `prepareTasks` produces, by calling the now-exported
`loadRepositoryManifest` — the exact function `runAsCli` uses (currently lines 446-462):

Current:
```
  const repositoryManifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [{
      occurrenceId: '',
      checkoutPath: root,
      parentOccurrenceId: null,
      pathInParent: null,
      gitlinkOid: null,
      depth: 0,
      originUrl: '',
      baseBranch: sourceBranch,
      baseOid,
      operationBranch: `task-${taskNumber}`,
      childOccurrenceIds: [],
      testState: 'untested',
    }],
  }
```
New:
```
  // Real production manifest; its empty operationBranch forces task.workflow.js to supply the branch.
  const repositoryManifest = loadRepositoryManifest(root)
  assert.equal(repositoryManifest.occurrences[0].operationBranch, '')
```
Delete the whole hand-built object literal and put those three lines in its place. `sourceBranch`
and `baseOid` are still declared above and still used by the rest of the test; leave them alone.
If `RepositoryManifest` or `REPOSITORY_MANIFEST_VERSION` become unused imports in this file after
this edit, drop them from the import list — but check first: the other five tests in this file
still hand-build manifests and probably still need both.

The rest of the test (unchanged) already exercises the real `createWorktreeForGroup` and asserts
the merge stage succeeds and closes the task (`merged.status === 'merged'`). With the real
manifest now supplying an empty `operationBranch`, the test fails unless `task.workflow.js`'s
`runMerge` sets the branch itself — this is the "integration test that uses prepareTasks' actual
returned manifest rather than a hand-built one" the brief calls for, and it reproduces the
historical bug shape exactly (the manifest names a branch the merge path cannot use).

**Edit 3** — add a new, standalone unit test proving `attachOperationBranch` is a pure function of
its `branch` argument (not a fixed/shared value), so two different task invocations sharing the
same `occurrences` array get two different, independently-correct branch names — this is the
"equivalent assertion" proving there is no `groups[0]`-style coupling to a single shared branch.
Add after the `'production-shaped: ...'` test (i.e. after the closing `})` for the test edited
above), before the file's final `test(...)` block if any, otherwise at end of file:

```
test('attachOperationBranch sets the given branch on every occurrence, independent of any other invocation', () => {
  const occurrences = [
    { occurrenceId: '', checkoutPath: '/root', parentOccurrenceId: null, pathInParent: null, gitlinkOid: null, depth: 0, originUrl: '', baseBranch: 'main', baseOid: 'x', operationBranch: 'stale', childOccurrenceIds: ['vendor'], testState: 'untested' as const },
    { occurrenceId: 'vendor', checkoutPath: '/root/vendor', parentOccurrenceId: '', pathInParent: 'vendor', gitlinkOid: null, depth: 1, originUrl: '', baseBranch: 'main', baseOid: 'y', operationBranch: 'stale', childOccurrenceIds: [], testState: 'untested' as const },
  ]
  const forTask111 = attachOperationBranch(occurrences, 'task-111')
  const forTask222 = attachOperationBranch(occurrences, 'task-222')
  assert.deepEqual(forTask111.map((o) => o.operationBranch), ['task-111', 'task-111'])
  assert.deepEqual(forTask222.map((o) => o.operationBranch), ['task-222', 'task-222'])
  // Same occurrences, different results: proves branch comes from each call's own argument.
  assert.notDeepEqual(forTask111, forTask222)
})
```
This test does not need `RepositoryManifest`/`REPOSITORY_MANIFEST_VERSION` imports; it builds
plain `RepositoryOccurrence`-shaped objects inline, matching the shape already used by this file's
other hand-built manifests.

No other edits to this file. The other five tests in this file (`makeRootWithWorktree` fixture,
taskNumbers 9001-9007) intentionally hand-build a manifest whose `operationBranch` matches the
literal git branch name they themselves create with `git worktree add -q -b <operationBranch>` —
that pattern is internally consistent (same variable names both), not the task-N/operations-scheme
mismatch this task fixes, and none of those tests import or call anything this task's edits
change, so they need no edit.

### tests/runMergePhase.test.ts

No edit. This file never imports from `scripts/prepareTasks.ts` or `scripts/operationBranches.ts`
(confirmed by reading its full import list, lines 1-11) — it only imports from
`scripts/repositoryManifest.ts` and `scripts/runMergePhase.ts`. Its one fixture that builds a
worktree and manifest (`makeQueueFixtureRepo`) creates the git branch directly with
`git worktree add -q -b ${operationBranch} worktreePath sourceBranch` and reuses that exact same
`operationBranch` variable in the manifest occurrence — self-consistent, not exercising
`prepareTasks.ts`'s manifest-building code at all, so it is unaffected by this task's fix and
demonstrates no naming mismatch for this fix to correct.

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`):

1. `npx tsc --noEmit`
   Expected: exits 0, no type errors (confirms the `RepositoryOccurrence` import, the new
   `attachOperationBranch` export, and its call sites in `prepareTasks.ts` and
   `task.workflow.js` all type-check).

2. `npm test`
   Expected: exits 0, all tests pass, including:
   - every existing test in `tests/taskWorkflowMergeStage.test.ts` (the `9001`-`9008`-numbered
     tests), in particular `'production-shaped: the worktree
     prepareTasks.createWorktreeForGroup produces is what task.workflow.js merges, with no chdir
     and the real script path'`, which now builds its manifest with the real, exported
     `loadRepositoryManifest` (empty `operationBranch`) and still passes (`merged.status ===
     'merged'`, `merged.closed === [taskNumber]`, worktree removed), because `runMerge` derives
     the real branch from `ARGS.task` rather than trusting the manifest field;
   - the new `'attachOperationBranch sets the given branch on every occurrence, independent of
     any other invocation'` test, which passes because the helper is a pure function of its
     `branch` argument;
   - every existing test in `tests/runMergePhase.test.ts` unchanged, including
     `test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`.
