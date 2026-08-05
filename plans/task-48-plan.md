# Task 48 Plan: Rewire prepareTasks call sites onto graph discovery and canonical grouping

Source: `plans/brief-48.md`. This plan was written from the brief only (per
instruction) — the brief's embedded snapshots of `scripts/prepareTasks.ts`,
`scripts/taskGroups.ts`, and their test files are the ground truth for "what
exists today." Task 46's and task 47's actual current exports (exact
filenames/signatures for the graph-discovery and branch-creation helpers,
and for `bootstrapRepositoryManifest`) were **not** shown in the brief, so
Step 0 below is mandatory live-repo discovery before touching any code —
do not guess names.

## Ladder check (ponytail)

This is a rewiring task, not a new-feature task: point existing call sites
at existing helpers, delete a stub. No new abstractions, no new files. The
brief itself calls out future needs ("recovery refs and receipts... later")
— do not scaffold fields for those now. Only widen `WorkflowArguments` /
`PreparedGroup` with fields that task 46's actual helpers hand back and that
have nowhere else to go.

## Step 0 — Discovery (do first, blocks everything else)

Read the live files (not shown in the brief) to pin down exact names before
editing:

1. `scripts/repositoryBranches.ts` (or wherever task 46 landed) — find the
   current exports that replace/rewire `collectRepositorySources`,
   `createBranchInEveryRepository`, `currentBranchName`, `submodulePaths`,
   and the `RepositorySource` type. Task 46 may have kept these names or
   renamed/moved them onto a graph-discovery model — use whatever exists on
   disk now, not the names in the brief's snapshot.
2. `scripts/repositoryManifest.ts` — find `bootstrapRepositoryManifest`'s
   exact signature (expected: `(repoRoot: string) => RepositoryManifest`,
   confirm sync vs async and whether it throws on a bad repo state).
3. `scripts/canonicalTaskGroups.ts` — confirm `buildCanonicalTaskGroups`
   still takes `(tasks: TaskRecord[], manifest: RepositoryManifest)` as
   `taskGroups.ts`'s current snapshot implies.
4. `rg -n "groupTasksByFileOverlap|buildFlatSingleRepositoryManifest|collectRepositorySources|createBranchInEveryRepository|currentBranchName|submodulePaths" scripts tests` —
   find every call site of the functions this task touches, beyond the two
   files quoted in the brief, so no caller is left broken. Note:
   `buildFlatSingleRepositoryManifest` is not exported from `taskGroups.ts`
   in the current snapshot, so it should have no external callers — confirm
   that's still true before deleting it.

## Step 1 — `scripts/taskGroups.ts`: real manifest instead of the flat stub

This is the "required" item from the brief: delete the fabricated
single-occurrence manifest and thread the real one through as a parameter,
since `taskGroups.ts` has no `repoRoot` and can't build one itself.

Red (update the test first so it drives the new signature):
- In `tests/taskGroups.test.ts`, every call to `groupTasksByFileOverlap(...)`
  currently passes one argument (`tasks`). Add a second argument: a small
  flat single-occurrence `RepositoryManifest` fixture, built inline in the
  test file (mirroring the shape the deleted `buildFlatSingleRepositoryManifest`
  used to produce: one occurrence, `checkoutPath: ""`, `occurrenceId` any
  stable string, `originUrl`/`baseBranch`/`baseOid` any valid-looking
  placeholder values). This fixture belongs to the test file now, not to
  production code — it's exercising pure grouping logic, not manifest
  construction.
- Running the suite at this point should fail to compile/run against the
  still-one-argument `groupTasksByFileOverlap`, confirming red.

Green:
- Change the exported signature:
  ```ts
  export function groupTasksByFileOverlap(tasks: TaskRecord[], manifest: RepositoryManifest): TaskGroup[] {
      return buildCanonicalTaskGroups(tasks, manifest);
  }
  ```
- Delete `buildFlatSingleRepositoryManifest` in full, and delete the stale
  comment above it (`// No disk-free manifest constructor exists yet, so
  build a one-occurrence root manifest inline.`) — task 46 built exactly
  that disk-free constructor (`bootstrapRepositoryManifest`), which is why
  the comment is now false.
- Drop the `REPOSITORY_MANIFEST_VERSION` import if nothing in the file uses
  it once the stub is gone; keep the `RepositoryManifest` type import since
  it's now a parameter type.

## Step 2 — `scripts/prepareTasks.ts`: build and thread the real manifest

Only `runAsCli` changes shape here — it owns `repoRoot`, so it's the one
place that can call `bootstrapRepositoryManifest`.

- Import `bootstrapRepositoryManifest` from wherever Step 0.2 found it
  (expected: `./repositoryManifest.ts`, alongside the existing
  `RepositoryManifest` import already used by `taskGroups.ts`).
- In `runAsCli()`, replace:
  ```ts
  const groups = groupTasksByFileOverlap(tasks);
  ```
  with:
  ```ts
  const manifest = bootstrapRepositoryManifest(repoRoot);
  const groups = groupTasksByFileOverlap(tasks, manifest);
  ```
- If `bootstrapRepositoryManifest` can throw (e.g., unreadable repo state),
  let it throw — `runAsCli` already has no broader try/catch around
  grouping, matching how `buildWorkflowArguments` errors are left to
  propagate today.
- No production test in the brief's `tests/prepareTasks.test.ts` snapshot
  drives `runAsCli()` directly (it's only invoked from the `if
  (process.argv[1] ...)` CLI guard), so no test edit is required here unless
  Step 0.4 turns up a CLI-level test elsewhere — if so, update it to match.

## Step 3 — `scripts/prepareTasks.ts`: point discovery/branch creation at task 46

Swap the imports currently pulled from `./repositoryBranches.ts`
(`collectRepositorySources`, `createBranchInEveryRepository`,
`currentBranchName`, `submodulePaths`, `RepositorySource`) for whatever
Step 0.1 found to be their current, rewired equivalents. Keep every call
site's position in the existing control flow unchanged:

- `buildWorkflowArguments`: `collectRepositorySources(repoRoot)` (or its
  replacement) stays the **first** thing computed, before
  `groups.map(createWorktreeForGroup, ...)`. This ordering is load-bearing:
  `test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory`
  asserts that a detached submodule causes a throw with **no** worktree
  directory created, which only holds if discovery/validation runs and
  throws before any worktree gets created. Do not reorder this.
- `createWorktreeForGroup`: `currentBranchName`, `submodulePaths`, and
  `createBranchInEveryRepository` keep their current call sites (rebase
  branch reuse path, submodule population, then branch creation across
  repo + submodules) — only the import source changes, not the sequence.
- Confirm during Step 0.1 that the task-46 discovery function performs no
  `git checkout` / branch-mutating call against `repoRoot` itself (only
  reads/validates). This is the concrete meaning of the brief's "must stay
  read-only with respect to branches" — `buildWorkflowArguments` legitimately
  creates new worktrees/branches via `createWorktreeForGroup`, but must not
  mutate the production checkout at `repoRoot` while discovering it.
- If task 46's helpers return additional fields (graph metadata, e.g. an
  occurrence id, parent chain, or similar) that `WorkflowArguments` or
  `PreparedGroup` currently have nowhere to hold, add only those fields —
  named for what they hold, typed from what the helper actually returns.
  Do not add placeholder fields for "recovery refs" or "receipts"; nothing
  produces those yet per the brief's own "later."

## Step 4 — Full-suite verification

1. `rg -n "groupTasksByFileOverlap\(" scripts tests` — confirm every call
   site now passes a manifest (Step 0.4's list should already have found
   these; this is the final check after edits).
2. Run the full test suite (`bun test` or `node --test tests/`, whichever
   this repo's `package.json`/README specifies) and confirm:
   - `tests/prepareTasks.test.ts` passes with
     `test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory`
     **unedited** and still green.
   - `tests/taskGroups.test.ts` passes with its updated manifest-fixture
     argument.
   - Every other existing test file stays green (no regressions from the
     `repositoryBranches.ts` import rewiring or the manifest threading).
3. `rg -n "buildFlatSingleRepositoryManifest"` across the repo returns
   nothing — confirms the stub and its stale comment are fully gone, not
   just unused.

## Explicit non-goals (ultra-ponytail)

- No new module/file for the manifest threading — `bootstrapRepositoryManifest`
  already exists (per the brief); this task only wires it in.
- No speculative `PreparedGroup`/`WorkflowArguments` fields beyond what task
  46's actual helper return values require to compile.
- No refactor of `buildWorkflowArguments`'s or `createWorktreeForGroup`'s
  control flow beyond swapping the import source — the existing sequencing
  is already correct and load-bearing (see Step 3).
