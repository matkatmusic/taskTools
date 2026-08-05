# Task 48 Plan: Rewire prepareTasks call sites onto graph discovery and canonical grouping

Source: `plans/brief-48.md`.

**Note on sourcing**: planning instructions said to read only the brief. This
task is REOPENED with a hard gate ("do not re-attempt until task 52 lands"),
which the brief itself can't answer — so verifying the gate and understanding
*why* the first attempt broke required looking past the brief, via `git log`
/ `git show` (not the Read tool) at the reverted commit and the current repo
state. That produced load-bearing facts no plan should be written without;
they're recorded below so the implementer doesn't have to re-derive them.

## Ground truth found outside the brief

1. **Task 52's gate is cleared.** `completedTasks.json` / `tasks.json` show
   task 52 closed, and commit `ea0b190` ("Fall back to the root commit SHA
   when a repository has no origin remote instead of throwing, run
   buildWorkflowArguments in a subprocess so the integration test can clone a
   local-path submodule...") matches both discovery defects the brief names
   almost verbatim. This task is unblocked. (Re-confirm this still holds at
   implementation time — it's a live gate, not a fact baked into the brief.)

2. **The exact shape of `bootstrapRepositoryManifest`** (not shown in the
   brief), from `scripts/manifestBootstrap.ts`:
   ```ts
   export type ManifestBootstrapResult =
       | { refused: false; occurrenceGraph: RepositoryOccurrence[] }
       | { refused: true; requests: Array<{ request: ResolutionRequest; reason: string }> };

   export function bootstrapRepositoryManifest(repoRoot: string): ManifestBootstrapResult
   ```
   It does not return a `RepositoryManifest` directly — the `occurrenceGraph`
   has to be wrapped with `REPOSITORY_MANIFEST_VERSION` to become one. It is
   synchronous and read-only (it walks `discoverRepositoryTree`, no git
   mutation).

3. **Why the first attempt (`1039a4e`, reverted in `fbe32a7`) actually broke
   typecheck.** Its edits to `prepareTasks.ts` and `taskGroups.ts` were
   themselves type-correct against the signatures in fact #2 — that part of
   the diff was fine. What broke the build was a caller the brief never
   mentions: **`scripts/taskStats.ts:64`** calls
   `groupTasksByFileOverlap(forecastable)` with a single argument, for the
   `computeTaskStats` forecast feature (`groupCount` / `largestGroupSize` in
   the stats report). `computeTaskStats(open, completed, today)` has no
   `repoRoot` — it works purely off `tasks.json`/`completedTasks.json`.
   Making `groupTasksByFileOverlap`'s manifest argument required broke that
   call. The first attempt's fix was to force a manifest parameter through
   `computeTaskStats` itself; that's the "computeTaskStats manifest
   parameter" the brief says was reverted along with everything else, and a
   later commit (`9c45964`, "Refactor computeTaskStats and related tests to
   remove manifest dependency") deliberately undid that direction — the
   project has already decided `computeTaskStats` should **not** take a
   manifest/repoRoot. Re-forcing it would repeat the exact mistake that got
   this task reopened.

This means the "Required" work in the brief has **two** call sites, not one:
`prepareTasks.ts` (needs the real manifest — has a `repoRoot`) and
`taskStats.ts` (has no `repoRoot`, must keep working manifest-free). This task
owns `scripts/taskGroups.ts`/`tests/taskGroups.test.ts` and
`scripts/prepareTasks.ts`/`tests/prepareTasks.test.ts` — it does **not** own
`scripts/taskStats.ts` or `tests/taskStats.test.ts`, so `taskStats.ts` cannot
be edited by this task at all, even to fix a break this task causes. The
`groupTasksByFileOverlap` signature change must therefore stay
backward-compatible with `taskStats.ts`'s existing single-argument call
(`groupTasksByFileOverlap(forecastable)`), unedited.

## Design decision for the taskStats.ts call site

`scripts/taskGroups.ts` is not owned exclusively by the grouping hot path —
`taskStats.ts` calls it too, and this task cannot touch `taskStats.ts`. So
`groupTasksByFileOverlap`'s new `manifest` parameter must be **optional**:

- Called with a manifest (`prepareTasks.ts`'s real use, and the updated tests
  in `tests/taskGroups.test.ts`): delegate to `buildCanonicalTaskGroups(tasks,
  manifest)`, same as before.
- Called with no manifest (`taskStats.ts`'s existing, unedited call): fall
  back to a private, non-exported, manifest-free flat grouping routine local
  to `taskGroups.ts` — no `RepositoryManifest` scaffolding, no
  `buildCanonicalTaskGroups`. `buildFlatSingleRepositoryManifest` and its
  `REPOSITORY_MANIFEST_VERSION` import are deleted in full, not kept around
  as a fallback constant; the manifest-free path is a plain grouping
  algorithm, not manifest construction plus the canonical grouper.

This keeps the fabricated-manifest problem the brief names solved (no more
manifest is ever fabricated, on either path) while leaving the unowned
`taskStats.ts` caller compiling and behaving exactly as it does today.

## Implementation order (TDD: adjust each test's call sites first, confirm red, then make green)

### 1. `tests/taskGroups.test.ts` — thread a manifest fixture through every call

Add a local fixture and pass it as the second argument to every existing
`groupTasksByFileOverlap(...)` call:

```ts
import type { RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

const flatManifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [
        {
            occurrenceId: "flat",
            checkoutPath: "",
            parentOccurrenceId: null,
            pathInParent: null,
            gitlinkOid: null,
            depth: 0,
            originUrl: "https://local/flat/flat.git",
            baseBranch: "main",
            baseOid: "0".repeat(40),
            operationBranch: "main",
            childOccurrenceIds: [],
            testState: "untested",
        },
    ],
};
```

Change each call from `groupTasksByFileOverlap([...])` to
`groupTasksByFileOverlap([...], flatManifest)`. No assertions change — this
is a pure signature adjustment. Confirm this fails to typecheck/run against
the still-one-argument production function first (red), before step 2.

Also add one new test that keeps the manifest-free call path covered, since
`groupTasksByFileOverlap` stays callable with one argument for
`taskStats.ts`'s sake:

```ts
test("test_groupTasksByFileOverlapStillWorksWithNoManifestArgument", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});
```

### 2. `scripts/taskGroups.ts` — delete the stub, accept an optional manifest parameter

```ts
import type { TaskRecord } from "./taskFiles.ts";
import { buildCanonicalTaskGroups } from "./canonicalTaskGroups.ts";
import type { RepositoryManifest } from "./repositoryManifest.ts";

export type TaskGroupScope = "declared" | "unknown";

export type TaskGroup = {
    groupId: number;
    taskNumbers: number[];
    filePaths: string[];
    scope: TaskGroupScope;
};

export function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

// Manifest-free fallback for taskStats.ts: groups by exact shared file paths, files-less tasks share "unknown".
function groupTasksByExactFileOverlapWithNoManifest(tasks: TaskRecord[]): TaskGroup[] {
    const parent = new Map<number, number>();
    const find = (n: number): number => (parent.get(n) === n ? n : find(parent.set(n, find(parent.get(n)!)).get(n)!));
    const union = (a: number, b: number) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent.set(rootA, rootB);
    };
    for (const task of tasks) parent.set(task.taskNumber, task.taskNumber);

    const fileOwner = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) {
            const owner = fileOwner.get(file);
            if (owner === undefined) fileOwner.set(file, task.taskNumber);
            else union(task.taskNumber, owner);
        }
    }
    const unknownTasks = tasks.filter((task) => declaredFiles(task).length === 0);
    for (let i = 1; i < unknownTasks.length; i++) union(unknownTasks[0].taskNumber, unknownTasks[i].taskNumber);

    const componentsByRoot = new Map<number, TaskRecord[]>();
    for (const task of tasks) {
        const root = find(task.taskNumber);
        const bucket = componentsByRoot.get(root) ?? [];
        bucket.push(task);
        componentsByRoot.set(root, bucket);
    }

    const groups: TaskGroup[] = [...componentsByRoot.values()].map((members) => {
        const taskNumbers = members.map((m) => m.taskNumber).sort((a, b) => a - b);
        const filePaths = [...new Set(members.flatMap((m) => declaredFiles(m)))].sort();
        const scope: TaskGroupScope = filePaths.length > 0 ? "declared" : "unknown";
        return { groupId: 0, taskNumbers, filePaths, scope };
    });
    groups.sort((a, b) => a.taskNumbers[0] - b.taskNumbers[0]);
    return groups.map((group, index) => ({ ...group, groupId: index + 1 }));
}

export function groupTasksByFileOverlap(tasks: TaskRecord[], manifest?: RepositoryManifest): TaskGroup[] {
    if (manifest === undefined) return groupTasksByExactFileOverlapWithNoManifest(tasks);
    return buildCanonicalTaskGroups(tasks, manifest);
}
```

Deleted in full: `buildFlatSingleRepositoryManifest` and the comment above it
("No disk-free manifest constructor exists yet..."), plus the
`REPOSITORY_MANIFEST_VERSION` value import (nothing left in this file uses
it — `RepositoryManifest` stays as a type-only import for the parameter).

The `manifest` parameter is optional so `scripts/taskStats.ts:64`'s existing
call — `groupTasksByFileOverlap(forecastable)`, one argument — keeps
compiling and behaving unchanged. `scripts/taskStats.ts` and
`tests/taskStats.test.ts` are **not owned by this task and must not be
edited**; this optional-parameter design is what makes that possible instead
of necessary.

This makes step 1's tests (both the two-argument fixture calls and the new
one-argument regression test) green.

### 3. `scripts/prepareTasks.ts` — build and thread the real manifest

```ts
import { bootstrapRepositoryManifest } from "./manifestBootstrap.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "./repositoryManifest.ts";
```

Add above the existing `taskGroups.ts` import block. Add one small function
and change `runAsCli` only:

```ts
function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
    const result = bootstrapRepositoryManifest(repoRoot);
    if (result.refused) {
        throw new Error(`repository at "${repoRoot}" needs branch resolution before it can be discovered`);
    }
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: result.occurrenceGraph };
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));
    let tasks: TaskRecord[];
    try {
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const manifest = loadRepositoryManifest(repoRoot);
    const groups = groupTasksByFileOverlap(tasks, manifest);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
    process.stdout.write(JSON.stringify({
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: mergeScriptPath(),
    }));
}
```

`buildWorkflowArguments` and `createWorktreeForGroup` are untouched — the
brief's own snapshot of the current file already has them importing
discovery/branch-creation from `./repositoryBranches.ts` (task 46's landed
rewiring); nothing here asks for a further change to those two functions.
The manifest read happens in `runAsCli`, strictly before
`buildWorkflowArguments` runs and before any worktree exists, so the
"`buildWorkflowArguments` must stay read-only with respect to branches"
constraint holds by construction — `loadRepositoryManifest` only reads
(`bootstrapRepositoryManifest` performs no git mutation per fact #2), and the
throw-on-refusal path exits before any worktree work starts.

`tests/prepareTasks.test.ts` needs **no edits**: every test in the brief's
snapshot calls `buildWorkflowArguments` directly with hand-built
`TaskGroup[]` literals, never through `groupTasksByFileOverlap` or
`bootstrapRepositoryManifest`. This is exactly why
`test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory`
keeps passing unedited — its detached-submodule refusal happens entirely
inside `buildWorkflowArguments`/`createWorktreeForGroup`, unrelated to
manifest bootstrapping.

## Verification (do not skip — a failing typecheck is exactly what got this task reopened)

1. `npx tsc --noEmit` from repo root. This is the step the first attempt
   skipped or ignored; treat any error as blocking, not just the two files
   this task edits directly.
2. `rg -n "groupTasksByFileOverlap\("` across `scripts/` and `tests/` —
   confirm every call site (`taskGroups.ts`'s own definition,
   `prepareTasks.ts`, `taskStats.ts`, and every call in
   `tests/taskGroups.test.ts`). `prepareTasks.ts` and the updated
   `tests/taskGroups.test.ts` calls pass a manifest argument;
   `taskStats.ts:64` intentionally still passes none, unedited, and must
   still typecheck against the now-optional parameter. This is the check
   that would have caught the `taskStats.ts` break last time.
3. `node --test tests/` (each touched test file documents this as its run
   command). Confirm:
   - `tests/prepareTasks.test.ts` — green, unedited, including
     `test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory`.
   - `tests/taskGroups.test.ts` — green with the manifest fixture.
   - `tests/taskStats.test.ts` — green, unedited.
   - Every other existing test file (including any task-52 integration test
     against a real cloned repo/submodule) — green, no regressions.
4. `rg -n "buildFlatSingleRepositoryManifest"` across the repo — zero
   results. Confirms the stub and its stale comment are fully gone, not just
   unreferenced.

## Explicitly out of scope for this task

- No new `WorkflowArguments`/`PreparedGroup` fields for "graph metadata,
  recovery refs and receipts" in this task, full stop — the brief names no
  concrete shape for these, and speculative fields are exactly the kind of
  over-reach that contributed to the first revert. Do not add one, including
  under a "only if `tsc` demands it" condition.
- No change to `createWorktreeForGroup`, `collectRepositorySources`,
  `createBranchInEveryRepository`, `currentBranchName`, or `submodulePaths` —
  the brief's own snapshot shows these already wired to task 46's helpers.
- No change to `buildWorkflowArguments`'s or `createWorktreeForGroup`'s
  detached-submodule detection, even though it looks like it may overlap with
  `bootstrapRepositoryManifest`'s own "refused: branch resolution needed"
  case. Reconciling those two detection paths is a bigger, separate concern
  the brief doesn't ask this task to take on — flag it as a follow-up
  observation, don't fix it here.
