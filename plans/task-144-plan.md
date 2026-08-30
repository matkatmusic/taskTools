# Task 144 plan — per-task ordered-merge primitive (deepest submodule first, then parent)

## Scope, settled up front

This task builds **one new primitive function** in `scripts/mergeTaskWorktrees.ts`,
`mergeTaskDeepestFirst`, that performs the FULL per-task walk of the 142→143→144
chain in one call: given a task worktree, for each occurrence deepest-submodule-first
then the parent last, it (a) checks — before touching that occurrence at all —
whether the occurrence's task branch is already fully merged into its own source
branch (a previous lap already finished it), and if so skips straight to reporting
`"no-op"`; otherwise (b) rebases that occurrence onto its source and runs its tests,
reusing task 142/143's existing `rebaseAndTestSubmoduleLayer`-equivalent logic and
`rebaseParentOntoSourceAndTest`, and (c) only on a clean rebase+test, merges that
occurrence's task-N branch into its own source branch via the existing
`mergeSubmoduleBranchIntoRepo` / `mergeGroupBranchIntoRepo`. Because the skip check
runs before step (b), an already-merged occurrence never gets rebased a second time
on a retry lap.

Per the brief's explicit chain-scope instructions:

- **Task 147** ("serial merge retry queue", files `scripts/runMergePhase.ts`,
  `tests/runMergePhase.test.ts`, `tests/mergePipeline.test.ts`) deletes
  `coordinateMergeRetry` and calls this task's primitive from its replacement.
  This plan does **not** wire the new primitive into `coordinateMergeRetry` or
  `runMergeCli` — both are dead ends task 147 removes/bypasses. `scripts/runMergePhase.ts`
  is read-only context for this plan; it is not edited. Composing this primitive
  with task 142/143's rebase functions is *not* the forbidden kind of wiring: both
  functions already live in, and stay in, `scripts/mergeTaskWorktrees.ts` — the
  file this task owns — and neither call touches `runMergePhase.ts` or
  `coordinateMergeRetry`.
- `scripts/mergePipeline.ts` is read-only context. It keeps using
  `basePublication.ts` for its own separate batch-publish workflow; this
  plan does not touch it.
- `scripts/basePublication.ts` needs **no edit** (justified below) — the
  "untangling" the brief asks for is achieved by this task's new primitive
  never routing through `coordinateMergeRetry`/`runMergePipeline`'s batch-CAS
  flow at all, not by changing `basePublication.ts`'s own code.

## Why `scripts/basePublication.ts` needs no edit

Read in full (250 lines). It imports only `spawnSync` and
`checkAuthorizationDrift`/`RunState` from `./approvalGate.ts` — nothing from
`runMergePhase.ts`, nothing referencing `coordinateMergeRetry`,
`MergeRetryDeps`, or `CliInput`. The only place `runMergePhase.ts` touches
`basePublication.ts` is a single import of `readCurrentRefOid` (used as the
`readRefOid` implementation inside `MergeRetryDeps`, `runMergePhase.ts:258`)
— that is `runMergePhase.ts` depending on `basePublication.ts`, not the
reverse, and it lives entirely in the file task 147 owns and rewrites.
`basePublication.ts`'s own code (`publishBases`, `publishCanonicalRef`,
`fastForwardOtherOccurrences`, `rollbackUpdatedRefs`,
`defaultCheckoutOperations`, etc.) is already structurally independent of
the batch-retry machinery. There is nothing in this file that reflects
`coordinateMergeRetry`-specific shapes to strip out. This task's new
`mergeTaskDeepestFirst` primitive does not call `basePublication.ts` at all
— it merges directly into each occurrence's real source branch via
`git checkout` + `git merge` (already how `mergeGroupBranchIntoRepo` /
`mergeSubmoduleBranchIntoRepo` work), which is a different mechanism than
`basePublication.ts`'s CAS-based `update-ref` + checkout-refresh publish
step. Because no behavior in `basePublication.ts` changes, `tests/basePublication.test.ts`
also needs no edit — there is no new behavior to cover there, and the
existing task-119 regression tests already there (`test_publishingCheckedOutCanonicalRefRefreshesRealIndexAndWorkingTree`
and neighbors) continue to guard `publishBases`'s own code path unchanged.
This task's own task-119-regression test (required by the brief) covers the
**new** primitive's code path instead, and belongs in
`tests/mergeTaskWorktrees.test.ts` (see Test 3 below), because
`mergeGroupBranchIntoRepo`/`mergeSubmoduleBranchIntoRepo` are the functions
that actually move the checked-out branch, not `basePublication.ts`.

## Design of the new primitive (why it's shaped this way)

Read in full: `scripts/mergeTaskWorktrees.ts` (487 lines) and
`tests/mergeTaskWorktrees.test.ts` (1270 lines), plus `scripts/repositoryDiscovery.ts`
(160 lines) to confirm exactly how `discoverRepositoryTree` assigns `occurrenceId`
(load-bearing for the manifest fixtures below).

Existing pieces reused, all already in this file:

- `rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, resolutionManifest, childrenByParentId)`
  (`scripts/mergeTaskWorktrees.ts:250`, private, not exported) — fetches the
  fresh base branch into the occurrence's own checkout, rebases if refs
  differ, records any changed child gitlink, then runs that layer's test
  policy. Returns a `SubmoduleLayerOutcome`. This task's new primitive
  lives in the same file, so it can call this private function directly —
  no new export is needed for it.
- `rebaseParentOntoSourceAndTest(occurrenceId, worktreePath, sourceBranch, submodulePaths, resolutionManifest)`
  (`scripts/mergeTaskWorktrees.ts:347`, already exported) — the parent
  equivalent: rebases the parent's task-N branch (auto-resolving gitlink
  conflicts restricted to `submodulePaths`), then tests it. Returns a
  `ParentRebaseOutcome`.
- `mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch)`
  (`scripts/mergeTaskWorktrees.ts:411`) — fetches the worktree submodule's
  current branch into the canonical submodule checkout, checks it out onto
  `sourceBranch`, and does a plain `git merge --no-ff`. On conflict it
  aborts and reports `conflictedFilePaths`/`failureReason`; it never rolls
  back a merge that already succeeded elsewhere.
- `mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, submodulePaths)`
  (`scripts/mergeTaskWorktrees.ts:375`) — checks out `sourceBranch` in
  `repoRoot`, merges `group.branch` with `--no-ff`, and on a conflict
  restricted to `submodulePaths` auto-resolves via `resolveGitlinkConflicts`
  (already existing, unchanged).
- `groupChildrenByParentId` and `unmergedCommitCount` (both already private
  helpers in the same file) — no new private helpers are needed.

**Why the primitive orchestrates rebase+test+merge together, in one function,
instead of assuming the caller already rebased everything:** the chain
goal (see brief) is "a reusable per-task primitive that rebases each layer,
proves that layer's tests pass, and only then merges deepest-submodule-first."
If the skip check for an already-merged occurrence only ran inside the merge
step, a retry lap would still re-rebase and re-test an occurrence a previous
lap had already fully merged into its real source branch — wasted work at
best, and on a submodule whose task branch is now an ancestor of its source,
a rebase attempt is meaningless busywork the brief's "detect and skip before
rebasing" instruction is written to prevent. So `mergeTaskDeepestFirst`
computes one skip set up front, before calling any rebase function, and an
occurrence in that set gets no fetch (beyond the one already done to compute
the skip set itself), no rebase, no test run, no child-gitlink check, and no
merge call.

**Why the skip check works correctly, mechanically:** for occurrence `X`
with `baseBranch` and `operationBranch`, `unmergedCommitCount(sourceCheckoutPath,
baseBranch, operationBranch) === 0` means every commit on `operationBranch`
is already reachable from `baseBranch` in the *canonical* checkout — true
exactly when a previous lap already merged `X`'s task-N branch into `X`'s
own source branch (the `--no-ff` merge commit made the task branch's tip an
ancestor of the source tip). This is computed against `sourceCheckoutPath`
(the real source checkout), not the task worktree, so it reflects the
canonical repository's actual state, immune to what any other in-flight
worktree currently looks like.

**Why ordering alone is NOT enough, and a gitlink-propagation step is
required:** merging a submodule's task tip `T` into its source branch with
`--no-ff` produces a *new* commit `M`; `M` is not `T`. The containing task
branch's gitlink for that submodule path still records `T`, because the
containing occurrence's rebase step ran before the child's merge existed and
could only record what the child's task branch pointed at then. If the
parent is merged in that state, the parent's source branch lands a gitlink
to `T` while the canonical submodule checkout sits at `M`. Nothing is
dangling — `T` is an ancestor of `M`, so it stays reachable — but the parent
checkout's working tree is now dirty against its own index, which is exactly
the task-119 staged-revert symptom the regression test exists to catch.

So the primitive must, for every non-skipped occurrence that has children,
propagate each completed child's *source-branch tip* into the containing
task checkout before rebasing and testing it:
`git update-index --cacheinfo 160000,<source-tip>,<pathInParent>`, then a
fixed-message commit when the staged tree actually changed. The tip is
tracked for every completed child, whether it was freshly merged or reported
`"no-op"` — a skipped child's source tip is still the OID the container must
point at. Occurrences in the precomputed skip set get no propagation step at
all: they are already merged, and touching their index would move a ref the
skip set exists to leave alone.

Ordering (submodules deepest-first, parent last) is still what makes the
child's tip reachable from the child's source branch before the parent
merge. Propagation is what makes the parent *record* that tip. Both are
required; the tests below prove each separately.

`resolveGitlinkConflicts` (already tested, unchanged) still handles the case
where a concurrent run advanced the parent's source independently and the
parent's own merge conflicts at a gitlink path. It is not a substitute for
propagation: it only fires on conflict, and the failure above is silent — no
conflict is raised when the parent cleanly lands a stale-but-reachable `T`.

## `occurrenceId` convention for the root occurrence — load-bearing, read this before writing fixtures

`discoverRepositoryTree` (`scripts/repositoryDiscovery.ts:150-159`) calls
`discoverOccurrenceAndDescendants(rootPath, "", null, null, 0, "", manifest, ...)`
for the top of the tree — its `relativePath` is `""`, and
`occurrenceId = relativePath` (`repositoryDiscovery.ts:84`). **The root
occurrence's real `occurrenceId` is the empty string `""`, not `"root"`.**
Its `parentOccurrenceId` is the literal `null` passed to that top call.
Every direct child of the root therefore gets `parentOccurrenceId: ""` once
discovery runs (line 140 threads the *parent's own* `occurrenceId`, `""` for
the root, down to each child) — regardless of whatever `parentOccurrenceId`
string the input manifest used for that child, because
`discoverOccurrenceAndDescendants` always sets `occurrence.parentOccurrenceId`
from its own live parameter and `Object.assign`s it onto the existing
manifest entry (`repositoryDiscovery.ts:109-125`).

This matters because `mergeTaskDeepestFirst` (unlike `rebaseSubmoduleLayersDeepestFirst`,
which never needs to look up the root's own source checkout) needs a manifest
entry for the root occurrence keyed correctly, so that
`sourceCheckoutPathByOccurrenceId.get(rootOccurrence.occurrenceId)` resolves.
That map is built by this task's new code from `manifest.repositoryManifest.occurrences`
**before** calling `discoverRepositoryTree` (so later mutation by discovery
can't invalidate it — same pattern `rebaseSubmoduleLayersDeepestFirst` and
`rebaseParentOntoSourceAndTest`'s callers already rely on). If the manifest's
root entry is keyed `"root"` instead of `""`, the lookup returns `undefined`,
the `!` assertion lies to the type checker, and the first `git(sourceCheckoutPath, ...)`
call for the root throws at runtime with `sourceCheckoutPath` being
`undefined`. **Every fixture below uses `""` as the root occurrence's
`occurrenceId` in the input manifest — never `"root"`.** (A worse failure
mode if `""` is *not* provided as an existing manifest entry at all: discovery
falls into its `parentOccurrenceId === null` branch and calls
`readRootBranchAndOid(rootPath)`, which reads whatever branch is *currently
checked out* in the worktree passed to `discoverRepositoryTree` — i.e. the
task-N branch, not the real source branch — silently corrupting `baseBranch`.
So the root manifest entry is not just correctly-keyed, it is *required*.)

For readability, the primitive's own outward-facing report fields
(`MergeLayerOutcome.occurrenceId`, and the failure fields on
`MergeTaskWalkReport`) display `""` as the string `"root"` — internal
lookups use the real `""` key throughout; only the value shown in reports
and asserted in tests is relabeled.

## Naming and field conventions reused from the existing rebase primitive

`rebaseSubmoduleLayersDeepestFirst` (`scripts/mergeTaskWorktrees.ts:313`)
establishes conventions this task's primitive copies exactly:

- `discoverRepositoryTree(worktreePath, manifest)` returns `discovery.graph`
  — occurrences anchored to the **task worktree** (their `.checkoutPath` is
  inside `worktreePath`; their `.baseBranch`/`.operationBranch` are threaded
  through from the input manifest when an existing entry with a non-empty
  `baseBranch` matches by `occurrenceId`).
- The **canonical** (real source) checkout path per occurrence comes
  separately, from `manifest.repositoryManifest.occurrences`, matched by
  `occurrenceId`, captured into a `Map` **before** `discoverRepositoryTree`
  runs (see previous section for why the timing matters).
- Deepest-first submodule ordering: `.sort((a, b) => b.depth - a.depth)` on
  `discovery.graph` entries (confirmed at `mergeTaskWorktrees.ts:325`).
- Direct-child gitlink paths for a parent occurrence: the existing
  `groupChildrenByParentId` helper (`mergeTaskWorktrees.ts:301-310`) groups
  `discovery.graph` occurrences by `parentOccurrenceId`; `pathInParent` on
  those grouped children is the real, worktree-derived value (this is
  reused as-is — built from `discovery.graph` *after* discovery runs, so it
  reflects the corrected `parentOccurrenceId`s discovery assigns, not
  whatever the input manifest said).

---

## File 1: `scripts/mergeTaskWorktrees.ts` — one insertion

No existing code in this file changes. Insert a new block immediately after
`removeWorktreeAndBranch` (lines 431-434) and before `runDiscoverCli` (line
436). No new imports are needed — every symbol used below
(`discoverRepositoryTree`, `DiscoveryManifest`, `PreparedGroup`,
`MergeOutcome`, `rebaseAndTestSubmoduleLayer`, `rebaseParentOntoSourceAndTest`,
`mergeSubmoduleBranchIntoRepo`, `mergeGroupBranchIntoRepo`,
`groupChildrenByParentId`, `unmergedCommitCount`, `git`) is already imported
or already defined earlier in this same file.

**Current text at lines 431-436** (the anchor; unchanged, just locating the
insertion point):

```
export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

function runDiscoverCli(): void {
```

**New text** — replace the above with the same text plus the inserted block
between the closing `}` of `removeWorktreeAndBranch` and
`function runDiscoverCli(): void {`:

```
export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

export type MergeStepOperations = {
    mergeSubmodule: (mainSubmodulePath: string, worktreeSubmodulePath: string, sourceBranch: string) => { merged: boolean; conflictedFilePaths: string[]; failureReason: string | null };
    mergeGroup: (repoRoot: string, group: PreparedGroup, sourceBranch: string, submodulePaths: string[]) => MergeOutcome;
};

export const defaultMergeStepOperations: MergeStepOperations = {
    mergeSubmodule: mergeSubmoduleBranchIntoRepo,
    mergeGroup: mergeGroupBranchIntoRepo,
};

function displayOccurrenceId(occurrenceId: string): string {
    return occurrenceId === "" ? "root" : occurrenceId;
}

export type MergeLayerOutcome =
    | { occurrenceId: string; checkoutPath: string; status: "no-op"; oid: string }
    | { occurrenceId: string; checkoutPath: string; status: "merged"; oid: string };

export type MergeTaskWalkReport =
    | { status: "merged"; completedLayers: MergeLayerOutcome[] }
    | {
          status: "submodule-conflicted";
          completedLayers: MergeLayerOutcome[];
          occurrenceId: string;
          checkoutPath: string;
          stage: "rebase" | "test" | "merge";
          conflictedFilePaths: string[];
          failureReason: string | null;
      }
    | {
          status: "parent-conflicted";
          completedLayers: MergeLayerOutcome[];
          checkoutPath: string;
          stage: "rebase" | "test" | "merge";
          conflictedFilePaths: string[];
          failureReason: string | null;
      };

// A child's --no-ff merge creates a new source tip; the container's task branch still records the child's pre-merge tip.
function propagateChildGitlinks(
    occurrence: DiscoveredOccurrence,
    childrenByParentId: Map<string, DiscoveredOccurrence[]>,
    sourceTipByOccurrenceId: Map<string, string>,
): void {
    let stagedAnyChange = false;
    for (const child of childrenByParentId.get(occurrence.occurrenceId) ?? []) {
        const childSourceTip = sourceTipByOccurrenceId.get(child.occurrenceId);
        if (childSourceTip === undefined || child.pathInParent === null) continue;
        const recordedOid = git(occurrence.checkoutPath, "rev-parse", `HEAD:${child.pathInParent}`).trim();
        if (recordedOid === childSourceTip) continue;
        git(occurrence.checkoutPath, "update-index", "--cacheinfo", `160000,${childSourceTip},${child.pathInParent}`);
        stagedAnyChange = true;
    }
    if (!stagedAnyChange) return;
    git(occurrence.checkoutPath, "commit", "-m", "taskTools: point submodule gitlinks at merged source tips");
}

// Rebases, tests, and merges each occurrence deepest-first; skips occurrences already merged into their own source branch.
export function mergeTaskDeepestFirst(
    worktreePath: string,
    manifest: DiscoveryManifest,
    mergeStepOperations: MergeStepOperations = defaultMergeStepOperations,
): MergeTaskWalkReport {
    const sourceCheckoutPathByOccurrenceId = new Map(
        manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence.checkoutPath]),
    );

    const discovery = discoverRepositoryTree(worktreePath, manifest);
    if (discovery.status === "needsResolution") {
        throw new Error(`repository tree discovery needs resolution for: ${discovery.resolutionRequests.map((request) => request.occurrenceId).join(", ")}`);
    }

    const rootOccurrence = discovery.graph.find((occurrence) => occurrence.parentOccurrenceId === null)!;
    const submoduleOccurrencesDeepestFirst = discovery.graph
        .filter((occurrence) => occurrence.parentOccurrenceId !== null)
        .sort((a, b) => b.depth - a.depth);
    const orderedOccurrences = [...submoduleOccurrencesDeepestFirst, rootOccurrence];
    const childrenByParentId = groupChildrenByParentId(discovery.graph);

    // Fetch each task branch first and mark occurrences already merged into source; those skip rebase, test, and merge.
    const skippedOccurrenceIds = new Set<string>();
    for (const occurrence of orderedOccurrences) {
        const sourceCheckoutPath = sourceCheckoutPathByOccurrenceId.get(occurrence.occurrenceId)!;
        if (occurrence.parentOccurrenceId !== null) {
            git(sourceCheckoutPath, "fetch", occurrence.checkoutPath, `${occurrence.operationBranch}:refs/heads/${occurrence.operationBranch}`);
        }
        if (unmergedCommitCount(sourceCheckoutPath, occurrence.baseBranch, occurrence.operationBranch) === 0) {
            skippedOccurrenceIds.add(occurrence.occurrenceId);
        }
    }

    const completedLayers: MergeLayerOutcome[] = [];
    // Every completed occurrence's source tip, so its container can record that OID rather than the child's pre-merge tip.
    const sourceTipByOccurrenceId = new Map<string, string>();
    for (const occurrence of orderedOccurrences) {
        const sourceCheckoutPath = sourceCheckoutPathByOccurrenceId.get(occurrence.occurrenceId)!;
        const displayId = displayOccurrenceId(occurrence.occurrenceId);

        if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "no-op", oid });
            continue;
        }

        propagateChildGitlinks(occurrence, childrenByParentId, sourceTipByOccurrenceId);

        if (occurrence.parentOccurrenceId !== null) {
            const rebaseOutcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId);
            if (rebaseOutcome.status === "conflicted") {
                return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: rebaseOutcome.conflictedFilePaths, failureReason: null };
            }
            if (rebaseOutcome.status === "cleanup-failed" || rebaseOutcome.status === "source-sync-failed") {
                return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: [], failureReason: rebaseOutcome.failureReason };
            }
            if (rebaseOutcome.status === "tests-failed") {
                return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: rebaseOutcome.testOutput };
            }
            if (rebaseOutcome.status === "untested") {
                return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: "test policy needs resolution" };
            }

            const result = mergeStepOperations.mergeSubmodule(sourceCheckoutPath, occurrence.checkoutPath, occurrence.baseBranch);
            if (!result.merged) {
                return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: result.conflictedFilePaths, failureReason: result.failureReason };
            }
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
            continue;
        }

        const directChildPathsInParent = (childrenByParentId.get(occurrence.occurrenceId) ?? [])
            .map((child) => child.pathInParent)
            .filter((pathInParent): pathInParent is string => pathInParent !== null);

        const parentOutcome = rebaseParentOntoSourceAndTest(occurrence.occurrenceId, occurrence.checkoutPath, occurrence.baseBranch, directChildPathsInParent, manifest.resolutionManifest);
        if (parentOutcome.status === "conflicted") {
            return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: parentOutcome.conflictedFilePaths, failureReason: null };
        }
        if (parentOutcome.status === "cleanup-failed") {
            return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: [], failureReason: parentOutcome.failureReason };
        }
        if (parentOutcome.status === "tests-failed") {
            return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: parentOutcome.testOutput };
        }
        if (parentOutcome.status === "untested") {
            return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: "test policy needs resolution" };
        }

        const group: PreparedGroup = { groupId: 0, worktree: occurrence.checkoutPath, branch: occurrence.operationBranch, scope: "unknown", tasks: [] };
        const result = mergeStepOperations.mergeGroup(sourceCheckoutPath, group, occurrence.baseBranch, directChildPathsInParent);
        if (!result.merged) {
            return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: result.conflictedFilePaths, failureReason: result.failureReason };
        }
        const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
        sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
        completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
    }

    return { status: "merged", completedLayers };
}

function runDiscoverCli(): void {
```

(The last line, `function runDiscoverCli(): void {`, is unchanged original
text shown only to make the insertion boundary unambiguous — do not
duplicate it.)

---

## File 2: `scripts/basePublication.ts` — no edit

See "Why `scripts/basePublication.ts` needs no edit" above. No lines
change.

---

## File 3: `tests/mergeTaskWorktrees.test.ts` — two edits

### Edit 3a — extend the existing import from `../scripts/mergeTaskWorktrees.ts`

**Current text (lines 16-24):**

```
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    rebaseGroupOntoSource,
    rebaseParentOntoSourceAndTest,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```

**New text:**

```
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    mergeTaskDeepestFirst,
    rebaseGroupOntoSource,
    rebaseParentOntoSourceAndTest,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
import type { MergeStepOperations } from "../scripts/mergeTaskWorktrees.ts";
```

(This mirrors the file's own existing convention of separate `import type
{...}` lines — see the current lines 9, 11, 13, 15.)

### Edit 3b — append one fixture helper and seven new tests at end of file

The file currently ends at line 1270 with the closing of
`test_rebaseGroupOntoSourceAbortsAndReportsCleanupFailedWhenStagingAnAllowedConflictFails`:

**Current text (exact final lines of the file, 1264-1270):**

```
    const outcome = rebaseGroupOntoSource(repoRoot, baseBranch, ["vendor"]);

    assert.equal(outcome.status, "cleanup-failed");
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-merge")), false);
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-apply")), false);
});
```

**New text** — append immediately after that (keep the existing content
exactly as-is; this is pure addition after the final `});`):

```

// Root's real occurrenceId is "" (repositoryDiscovery.ts:84), not "root"; reports relabel it for readability.
const ROOT_OCCURRENCE_ID = "";

function buildMergePrimitiveFixture(): {
    rootPath: string;
    mainSubmodulePath: string;
    sourceBranch: string;
    submoduleSourceBranch: string;
    group: PreparedGroup;
    worktreeSubmodulePath: string;
    discoveryManifest: DiscoveryManifest;
} {
    const rootPath = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(rootPath, "vendor");
    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const rootBaseOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();
    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence(ROOT_OCCURRENCE_ID, null, sourceBranch, rootBaseOid, group.branch, rootPath),
            makeOccurrence("vendor", ROOT_OCCURRENCE_ID, submoduleSourceBranch, submoduleBaseOid, group.branch, mainSubmodulePath),
        ],
    };
    return {
        rootPath,
        mainSubmodulePath,
        sourceBranch,
        submoduleSourceBranch,
        group,
        worktreeSubmodulePath,
        discoveryManifest: { repositoryManifest: manifest, resolutionManifest: emptyResolutionManifest() },
    };
}

// Commits submodule work, then a later separate commit bumps the parent's gitlink so the merge sees it.
function commitSubmoduleWorkAndBumpParentGitlink(fixture: { group: PreparedGroup; worktreeSubmodulePath: string }): string {
    writeFileSync(join(fixture.worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(fixture.worktreeSubmodulePath, "add", "vendor-new.txt");
    git(fixture.worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");
    const vendorTaskCommitOid = git(fixture.worktreeSubmodulePath, "rev-parse", "HEAD").trim();

    git(fixture.group.worktree, "add", "vendor");
    git(fixture.group.worktree, "commit", "-q", "-m", "bump vendor gitlink");

    return vendorTaskCommitOid;
}

test("test_mergeTaskDeepestFirstMergesTheSubmoduleBeforeTheParentAndProvesReachabilityAtParentEntry", () => {
    const fixture = buildMergePrimitiveFixture();
    const vendorTaskCommitOid = commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    const invocationOrder: string[] = [];
    const reachabilityAtParentEntry = { checked: false, reachable: false };
    const gitlinkAtParentEntry = { recorded: "", childSourceTip: "" };
    const wrappedMergeSubmodule: MergeStepOperations["mergeSubmodule"] = (mainSubmodulePath, worktreeSubmodulePath, sourceBranch) => {
        invocationOrder.push("submodule");
        return mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch);
    };
    const wrappedMergeGroup: MergeStepOperations["mergeGroup"] = (repoRoot, group, sourceBranch, submodulePaths) => {
        invocationOrder.push("parent");
        reachabilityAtParentEntry.checked = true;
        try {
            git(fixture.mainSubmodulePath, "merge-base", "--is-ancestor", vendorTaskCommitOid, fixture.submoduleSourceBranch);
            reachabilityAtParentEntry.reachable = true;
        } catch {
            reachabilityAtParentEntry.reachable = false;
        }
        // Propagation must already have run: the parent task branch records M, not T.
        gitlinkAtParentEntry.recorded = git(fixture.group.worktree, "rev-parse", "HEAD:vendor").trim();
        gitlinkAtParentEntry.childSourceTip = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();
        return mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, submodulePaths);
    };

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest, {
        mergeSubmodule: wrappedMergeSubmodule,
        mergeGroup: wrappedMergeGroup,
    });

    assert.equal(report.status, "merged");
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor", "root"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["merged", "merged"]);
    assert.deepEqual(invocationOrder, ["submodule", "parent"]);
    assert.equal(reachabilityAtParentEntry.checked, true);
    assert.equal(reachabilityAtParentEntry.reachable, true);
    assert.equal(gitlinkAtParentEntry.recorded, gitlinkAtParentEntry.childSourceTip);
    assert.notEqual(gitlinkAtParentEntry.recorded, vendorTaskCommitOid);
});

test("test_mergeTaskDeepestFirstMergesGrandchildThenChildThenParentAndProvesReachabilityAtEachContainingEntry", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const innerOrigin = makeTempRepoWithCommit();
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");
    const rootSourceBranch = currentBranchName(rootPath);
    const rootBaseOid = git(rootPath, "rev-parse", rootSourceBranch).trim();

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(rootPath, "checkout", "-q", "-b", "task-1");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");
    const innerTaskCommitOid = git(innerCheckoutPath, "rev-parse", "HEAD").trim();

    // Gitlink bump is its own commit, after the child commit it records (ordering matters, see helper above).
    git(vendorCheckoutPath, "add", "inner");
    git(vendorCheckoutPath, "commit", "-q", "-m", "bump inner gitlink");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");
    const vendorTaskCommitOid = git(vendorCheckoutPath, "rev-parse", "HEAD").trim();

    git(rootPath, "add", "vendor");
    git(rootPath, "commit", "-q", "-m", "bump vendor gitlink");
    writeFileSync(join(rootPath, "root-work.txt"), "root work\n");
    git(rootPath, "add", "root-work.txt");
    git(rootPath, "commit", "-q", "-m", "root work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence(ROOT_OCCURRENCE_ID, null, rootSourceBranch, rootBaseOid, "task-1", rootPath),
                makeOccurrence("vendor", ROOT_OCCURRENCE_ID, vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const invocationOrder: string[] = [];
    const reachabilityAtVendorEntry = { checked: false, reachable: false };
    const reachabilityAtRootEntry = { checked: false, reachable: false };
    const gitlinkAtVendorEntry = { recorded: "", childSourceTip: "" };
    const gitlinkAtRootEntry = { recorded: "", childSourceTip: "" };

    const wrappedMergeSubmodule: MergeStepOperations["mergeSubmodule"] = (mainSubmodulePath, worktreeSubmodulePath, sourceBranch) => {
        const isInner = mainSubmodulePath === innerOrigin;
        invocationOrder.push(isInner ? "inner" : "vendor");
        if (!isInner) {
            reachabilityAtVendorEntry.checked = true;
            try {
                git(innerOrigin, "merge-base", "--is-ancestor", innerTaskCommitOid, innerSourceBranch);
                reachabilityAtVendorEntry.reachable = true;
            } catch {
                reachabilityAtVendorEntry.reachable = false;
            }
            // Vendor's task branch must already record inner's post-merge source tip.
            gitlinkAtVendorEntry.recorded = git(vendorCheckoutPath, "rev-parse", "HEAD:inner").trim();
            gitlinkAtVendorEntry.childSourceTip = git(innerOrigin, "rev-parse", innerSourceBranch).trim();
        }
        return mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch);
    };
    const wrappedMergeGroup: MergeStepOperations["mergeGroup"] = (repoRoot, group, sourceBranch, submodulePaths) => {
        invocationOrder.push("root");
        reachabilityAtRootEntry.checked = true;
        try {
            git(vendorOrigin, "merge-base", "--is-ancestor", vendorTaskCommitOid, vendorSourceBranch);
            reachabilityAtRootEntry.reachable = true;
        } catch {
            reachabilityAtRootEntry.reachable = false;
        }
        // Root's task branch must already record vendor's post-merge source tip.
        gitlinkAtRootEntry.recorded = git(rootPath, "rev-parse", "HEAD:vendor").trim();
        gitlinkAtRootEntry.childSourceTip = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();
        return mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, submodulePaths);
    };

    const report = mergeTaskDeepestFirst(rootPath, manifest, {
        mergeSubmodule: wrappedMergeSubmodule,
        mergeGroup: wrappedMergeGroup,
    });

    assert.equal(report.status, "merged");
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor/inner", "vendor", "root"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["merged", "merged", "merged"]);
    assert.deepEqual(invocationOrder, ["inner", "vendor", "root"]);
    assert.equal(reachabilityAtVendorEntry.checked, true);
    assert.equal(reachabilityAtVendorEntry.reachable, true);
    assert.equal(reachabilityAtRootEntry.checked, true);
    assert.equal(reachabilityAtRootEntry.reachable, true);
    assert.equal(gitlinkAtVendorEntry.recorded, gitlinkAtVendorEntry.childSourceTip);
    assert.notEqual(gitlinkAtVendorEntry.recorded, innerTaskCommitOid);
    assert.equal(gitlinkAtRootEntry.recorded, gitlinkAtRootEntry.childSourceTip);
    assert.notEqual(gitlinkAtRootEntry.recorded, vendorTaskCommitOid);
});

test("test_mergeTaskDeepestFirstLeavesNoDanglingGitlinkAfterEveryTaskBranchIsDeleted", () => {
    const fixture = buildMergePrimitiveFixture();
    const submoduleTaskBranch = currentBranchName(fixture.worktreeSubmodulePath);
    const vendorTaskCommitOid = commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest);
    assert.equal(report.status, "merged");

    const rootGitlinkOid = git(fixture.rootPath, "ls-tree", fixture.sourceBranch, "vendor").trim().split(/\s+/)[2];
    const submoduleSourceTip = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();
    // Parent must record the post-merge source tip M, not the pre-merge task tip T.
    assert.equal(rootGitlinkOid, submoduleSourceTip);
    // T is still reachable from M, so nothing the parent previously pointed at was lost.
    assert.doesNotThrow(() => git(fixture.mainSubmodulePath, "merge-base", "--is-ancestor", vendorTaskCommitOid, fixture.submoduleSourceBranch));

    removeWorktreeAndBranch(fixture.rootPath, fixture.group.worktree, fixture.group.branch);
    git(fixture.mainSubmodulePath, "branch", "-D", submoduleTaskBranch);

    assert.doesNotThrow(() => git(fixture.rootPath, "rev-parse", fixture.sourceBranch));
    assert.doesNotThrow(() => git(fixture.mainSubmodulePath, "merge-base", "--is-ancestor", rootGitlinkOid, fixture.submoduleSourceBranch));
});

test("test_mergeTaskDeepestFirstLeavesTheSourceCheckoutsIndexAndWorkingTreeAtTheMergedCommit", () => {
    const fixture = buildMergePrimitiveFixture();
    commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest);
    assert.equal(report.status, "merged");

    const rootMergedOid = git(fixture.rootPath, "rev-parse", fixture.sourceBranch).trim();
    const submoduleMergedOid = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();

    assert.equal(git(fixture.rootPath, "rev-parse", "HEAD").trim(), rootMergedOid);
    assert.equal(git(fixture.rootPath, "write-tree").trim(), git(fixture.rootPath, "rev-parse", `${rootMergedOid}^{tree}`).trim());
    assert.equal(git(fixture.rootPath, "status", "--short").trim(), "");

    assert.equal(git(fixture.mainSubmodulePath, "rev-parse", "HEAD").trim(), submoduleMergedOid);
    assert.equal(git(fixture.mainSubmodulePath, "write-tree").trim(), git(fixture.mainSubmodulePath, "rev-parse", `${submoduleMergedOid}^{tree}`).trim());
    assert.equal(git(fixture.mainSubmodulePath, "status", "--short").trim(), "");
});

test("test_mergeTaskDeepestFirstSkipsAnOccurrenceAlreadyMergedIntoItsSourceWithoutInvokingItsRebaseOrMergeStep", () => {
    const fixture = buildMergePrimitiveFixture();
    commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    // Simulate a previous lap that already merged the submodule before a later layer failed.
    const preMergeResult = mergeSubmoduleBranchIntoRepo(fixture.mainSubmodulePath, fixture.worktreeSubmodulePath, fixture.submoduleSourceBranch);
    assert.equal(preMergeResult.merged, true);
    const submoduleOidAfterPreMerge = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();
    // Rebasing happens in the task checkout, so its branch OID is what proves no rebase ran.
    const submoduleTaskBranchOidBeforeSecondLap = git(fixture.worktreeSubmodulePath, "rev-parse", "HEAD").trim();

    let submoduleMergeCalled = false;
    const refusingMergeSubmodule: MergeStepOperations["mergeSubmodule"] = () => {
        submoduleMergeCalled = true;
        return { merged: false, conflictedFilePaths: [], failureReason: "should not be called" };
    };

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest, {
        mergeSubmodule: refusingMergeSubmodule,
        mergeGroup: mergeGroupBranchIntoRepo,
    });

    assert.equal(submoduleMergeCalled, false);
    // Skipped means no rebase attempt: the task branch in the task checkout never moved.
    assert.equal(git(fixture.worktreeSubmodulePath, "rev-parse", "HEAD").trim(), submoduleTaskBranchOidBeforeSecondLap);
    assert.equal(report.status, "merged");
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["no-op", "merged"]);
    const skippedLayer = report.completedLayers[0];
    assert.equal(skippedLayer.status, "no-op");
    if (skippedLayer.status === "no-op") assert.equal(skippedLayer.oid, submoduleOidAfterPreMerge);
});

test("test_mergeTaskDeepestFirstLeavesAnAlreadyMergedSubmoduleInPlaceWhenTheParentThenConflicts", () => {
    const rootPath = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(rootPath, "vendor");
    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    writeFileSync(join(rootPath, "shared.txt"), "line1\n");
    git(rootPath, "add", "shared.txt");
    git(rootPath, "commit", "-q", "-m", "add shared.txt");
    const rootBaseOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();

    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence(ROOT_OCCURRENCE_ID, null, sourceBranch, rootBaseOid, group.branch, rootPath),
            makeOccurrence("vendor", ROOT_OCCURRENCE_ID, submoduleSourceBranch, submoduleBaseOid, group.branch, mainSubmodulePath),
        ],
    };
    const discoveryManifest: DiscoveryManifest = { repositoryManifest: manifest, resolutionManifest: emptyResolutionManifest() };

    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(worktreeSubmodulePath, "add", "vendor-new.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");
    git(group.worktree, "add", "vendor");
    git(group.worktree, "commit", "-q", "-m", "bump vendor gitlink");

    writeFileSync(join(rootPath, "shared.txt"), "line1-from-main\n");
    git(rootPath, "add", "shared.txt");
    git(rootPath, "commit", "-q", "-m", "main edit");

    const report = mergeTaskDeepestFirst(group.worktree, discoveryManifest);

    assert.equal(report.status, "parent-conflicted");
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["merged"]);

    const submoduleLayer = report.completedLayers[0];
    const submoduleOidAfterMerge = submoduleLayer.status === "merged" ? submoduleLayer.oid : null;
    assert.equal(git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim(), submoduleOidAfterMerge);
});

test("test_mergeTaskDeepestFirstStopsAtASubmoduleConflictWithoutAttemptingTheParentMerge", () => {
    const rootPath = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(rootPath, "vendor");
    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const rootBaseOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();

    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence(ROOT_OCCURRENCE_ID, null, sourceBranch, rootBaseOid, group.branch, rootPath),
            makeOccurrence("vendor", ROOT_OCCURRENCE_ID, submoduleSourceBranch, submoduleBaseOid, group.branch, mainSubmodulePath),
        ],
    };
    const discoveryManifest: DiscoveryManifest = { repositoryManifest: manifest, resolutionManifest: emptyResolutionManifest() };

    writeFileSync(join(worktreeSubmodulePath, "seed.txt"), "from-worktree\n");
    git(worktreeSubmodulePath, "add", "seed.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(mainSubmodulePath, "seed.txt"), "from-main\n");
    git(mainSubmodulePath, "add", "seed.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "main edit");

    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    let parentMergeCalled = false;
    const refusingMergeGroup: MergeStepOperations["mergeGroup"] = () => {
        parentMergeCalled = true;
        return { groupId: 0, merged: false, conflictedFilePaths: [], submoduleConflicts: [], worktree: group.worktree, failureReason: "should not be called" };
    };

    const report = mergeTaskDeepestFirst(group.worktree, discoveryManifest, {
        mergeSubmodule: mergeSubmoduleBranchIntoRepo,
        mergeGroup: refusingMergeGroup,
    });

    assert.equal(parentMergeCalled, false);
    assert.equal(report.status, "submodule-conflicted");
    assert.deepEqual(report.completedLayers, []);
});
```

### Why this test set

- Test 1 (`...ProvesReachabilityAtParentEntry`) satisfies both the brief's
  "ordering" TEST bullet and "prove ordering on the SUCCESS path,
  observably": it wraps both production merge functions, asserts invocation
  order, and asserts — AT ENTRY to the parent wrapper, before calling the
  real `mergeGroupBranchIntoRepo` — that the submodule's task commit is
  already an ancestor of the submodule's real source branch. It uses
  `commitSubmoduleWorkAndBumpParentGitlink` so the parent's tree actually
  records the gitlink bump (see that helper's comment for why commit order
  matters), so this is a genuine gitlink-conflict-bearing merge, not a
  no-op parent merge.
- Test 2 (`...MergesGrandchildThenChildThenParentAndProvesReachabilityAtEachContainingEntry`)
  is the required three-level success test: `vendor/inner` (grandchild),
  `vendor` (child/containing submodule), `root` (parent), each wrapped, each
  entry asserting the deeper occurrence's task commit is already reachable
  from its own real source branch before the containing merge runs. It
  follows the same manual-checkout construction as the existing 3-level
  rebase test (`test_rebaseSubmoduleLayersDeepestFirstRebasesTheDeepestSubmoduleBeforeItsContainerAndRecordsItsRebasedGitlink`,
  `tests/mergeTaskWorktrees.test.ts:834-918`), extended with a root manifest
  entry (keyed `""`, see the occurrenceId section above) because — unlike
  the rebase-only primitive — `mergeTaskDeepestFirst` also merges the root.
- Test 3 (`...LeavesNoDanglingGitlink...`) satisfies the "no dangling
  gitlinks" TEST bullet literally: it deletes every task-N branch in both
  repositories and then asserts the parent's source branch still resolves,
  and that its gitlink for `vendor` equals the submodule source branch's
  post-merge tip `M` — not the pre-merge task tip `T`, which is what the
  gitlink-propagation step exists to correct. It separately asserts `T` is
  an ancestor of `M`, so nothing the parent previously pointed at was lost.
  Asserting the gitlink equals `T` would pass a merge that leaves the parent
  checkout dirty, which is the task-119 symptom Test 4 catches.
- Test 4 (`...LeavesTheSourceCheckoutsIndexAndWorkingTreeAtTheMergedCommit`)
  satisfies the "task 119 regression" TEST bullet for this primitive's own
  code path: after a successful merge, `HEAD`, `write-tree`, and a clean
  `git status --short` all agree with the merged commit, at both the root
  and the submodule canonical checkouts.
- Test 5 (`...SkipsAnOccurrenceAlreadyMergedIntoItsSourceWithoutInvokingItsRebaseOrMergeStep`)
  satisfies "detect already-merged occurrences before rebasing, not after":
  it pre-merges the submodule directly (simulating a prior lap's partial
  success), records the submodule *task checkout's* branch OID before the
  second lap, then proves the primitive's own walk skips it — no merge
  step invocation, and (this is the part specific to fixing the rebase-timing
  problem) that task branch OID never moves, proving no rebase was attempted
  either — while still merging the parent normally. The task checkout is the
  right place to look: rebasing happens there, so the canonical checkout's
  `HEAD` would stay put whether or not a rebase ran, and asserting on it
  proves nothing.
- Tests 6 and 7 satisfy "report distinct failure variants... neither resets
  nor rolls back an already-merged submodule": Test 6 proves a
  `"parent-conflicted"` outcome leaves an already-`"merged"` submodule's new
  commit in place on its source branch (no rollback). Test 7 proves a
  `"submodule-conflicted"` outcome stops the walk before the parent's merge
  step is ever invoked.
- None of the seven tests use `rmSync` for cleanup (branch/worktree removal
  goes through `removeWorktreeAndBranch` and plain `git branch -D`, mirroring
  existing tests in this file), so the brief's conditional instruction to
  add `rmSync` to the `node:fs` import does not apply — the existing import
  on line 5 (`existsSync, mkdirSync, mkdtempSync, readFileSync,
  writeFileSync`) needs no change.
- Tests 6 and 7 build their fixtures manually (not via
  `buildMergePrimitiveFixture`/`commitSubmoduleWorkAndBumpParentGitlink`)
  because each needs a *conflicting* edit that the shared helper's clean
  "add a new file" commits don't produce. Test 6 still applies the
  "commit the child, then separately commit the parent's gitlink bump"
  ordering by hand, since its parent-conflict assertion depends on the
  submodule's merge having actually landed a real gitlink change. Test 7
  does not add a gitlink-bump commit at all: its submodule conflict is on
  `seed.txt` content, the walk never reaches the parent, and no gitlink
  comparison is ever asserted for it.

---

## File 4: `tests/basePublication.test.ts` — no edit

See "Why `scripts/basePublication.ts` needs no edit" above — no new
production behavior in that file, so no new test is needed there. The
task-119 regression required by the brief is covered instead by Test 4 in
`tests/mergeTaskWorktrees.test.ts`, against the code path this task
actually adds.

---

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`):

1. `npx tsc --noEmit`
   Expected: exits 0, no type errors (in particular: `MergeStepOperations`,
   `MergeLayerOutcome`, `MergeTaskWalkReport`, `defaultMergeStepOperations`,
   and `mergeTaskDeepestFirst` all type-check against the existing
   `PreparedGroup`, `MergeOutcome`, `DiscoveryManifest`, `SubmoduleLayerOutcome`,
   and `ParentRebaseOutcome` types they reuse).

2. `npm test`
   (runs `node --test "tests/**/*.test.ts"`, per `package.json`)
   Expected: exits 0. Node's test runner reports all pre-existing tests
   still passing (none of their source text changed) plus 7 new passing
   tests named:
   - `test_mergeTaskDeepestFirstMergesTheSubmoduleBeforeTheParentAndProvesReachabilityAtParentEntry`
   - `test_mergeTaskDeepestFirstMergesGrandchildThenChildThenParentAndProvesReachabilityAtEachContainingEntry`
   - `test_mergeTaskDeepestFirstLeavesNoDanglingGitlinkAfterEveryTaskBranchIsDeleted`
   - `test_mergeTaskDeepestFirstLeavesTheSourceCheckoutsIndexAndWorkingTreeAtTheMergedCommit`
   - `test_mergeTaskDeepestFirstSkipsAnOccurrenceAlreadyMergedIntoItsSourceWithoutInvokingItsRebaseOrMergeStep`
   - `test_mergeTaskDeepestFirstLeavesAnAlreadyMergedSubmoduleInPlaceWhenTheParentThenConflicts`
   - `test_mergeTaskDeepestFirstStopsAtASubmoduleConflictWithoutAttemptingTheParentMerge`

3. `node --test tests/mergeTaskWorktrees.test.ts` (scoped re-run, faster
   iteration while implementing) — expected: same pass count as the
   relevant slice of step 2.

No other files change, so no other verification is needed:
`scripts/basePublication.ts`, `tests/basePublication.test.ts`,
`scripts/runMergePhase.ts`, and `scripts/mergePipeline.ts` are all
untouched by this plan.
