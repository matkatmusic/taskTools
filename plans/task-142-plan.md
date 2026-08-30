# Task 142 plan: recursive submodule-layer rebase in mergeTaskWorktrees.ts

## Goal

Add a function to `scripts/mergeTaskWorktrees.ts` that, given a task's
worktree path and a populated `DiscoveryManifest` whose occurrences'
`checkoutPath` fields point at each occurrence's real **source** checkout
(not the worktree — see "Source checkout paths" below), rebases every
submodule's task branch onto that submodule's own **freshly-fetched** source
tip, **deepest submodule first**, running that submodule's own tests after a
clean rebase and **before** moving up to the submodule that contains it.
Before running those tests, it also re-commits that layer's own gitlink to
any direct child submodule whose task-branch commit changed during this
walk, so a rebased child's new commit — not its pre-rebase commit — is what
the parent's tests (and the parent's eventual merge) see. A layer is only
reported as a no-op when **both** of its own branch comparisons are zero
**and** none of its direct children's gitlinks changed; a layer whose own
task branch is already identical to its source tip but whose working tree
now disagrees with its recorded gitlink (because a deeper child was just
rebased) still skips its own `rebaseGroupOntoSource` call but still commits
the updated gitlink and still runs its own tests, deepest-first propagation
depends on this. It reports (never spawns agents) and stops the walk on the
first layer whose source fetch fails, whose rebase conflicts, or whose tests
fail. Nothing merges and the parent repository is never touched — that is
task 143 (parent rebase) and task 144 (merge).

Reused, not reimplemented: `rebaseGroupOntoSource` (mergeTaskWorktrees.ts:135,
exported, unchanged), the private `unmergedCommitCount` and `gitErrorText`
helpers (mergeTaskWorktrees.ts:54 and :34, same module, called directly —
neither is exported and neither needs to be), `discoverRepositoryTree`
(repositoryDiscovery.ts:150, imported), and `discoverTestPolicy`
(testPolicy.ts:64, imported, per task-86-spec.md's explicit instruction that
each layer's test command is discovered this way).

## Source checkout paths — why the input manifest's `checkoutPath` matters

`rebaseGroupOntoSource(checkoutPath, sourceBranch)` runs `git rebase
sourceBranch` inside `checkoutPath`, rebasing onto whatever commit the
**local** ref named `sourceBranch` currently points at in that checkout. A
task worktree's submodule checkout is its own separate clone; nothing keeps
its local `baseBranch` ref in sync with the real submodule source as other
tasks merge and advance it between laps. Rebasing onto a stale local ref
would silently rebase onto the wrong (old) tip.

So before rebasing a layer, the walk fetches that layer's `baseBranch` from
its **source checkout** — the actual, non-worktree checkout of that
submodule, where merges land — into the task worktree's checkout, using the
same `git fetch <path> <branch>:<branch>` pattern the file already uses in
`mergeSubmoduleBranchIntoRepo` (line 215) for the reverse direction, and
already used manually in this task's own first test (see below).

The function's caller is expected to build the input `DiscoveryManifest`
with each submodule occurrence's `checkoutPath` set to that occurrence's
**source** checkout path (this is the natural shape of a manifest freshly
discovered against the real, non-worktree repository — which is what a
caller has on hand before ever creating a task worktree). The walk function
captures those source paths from `manifest.repositoryManifest.occurrences`
**before** calling `discoverRepositoryTree(worktreePath, manifest)`, because
that call mutates every occurrence's `checkoutPath` in place to point into
the worktree instead (repositoryDiscovery.ts:109-122, documented below). A
submodule occurrence that reaches this function without an `existing` entry
of its own — i.e. without a source `checkoutPath` already captured — cannot
occur: `discoverRepositoryTree` only avoids `needsResolution` for a
submodule when `existing` is present with a non-empty `baseBranch`
(repositoryDiscovery.ts:99-107), and every submodule this task processes is
proven (in every test below) to already have a resolved `baseBranch` in the
input manifest, so it already has a captured source `checkoutPath` too.

## Files

### `plans/task-86-spec.md` — no edit

Read-only spec context. It documents the four-stage `task.workflow.js` design
and the serial-tail rebase/test/merge algorithm this task implements one
piece of (submodule-layer rebase + test only). Nothing in it is edited by
this task.

### `scripts/repositoryDiscovery.ts` — no edit

Read-only. Confirms `discoverRepositoryTree(rootPath, manifest: DiscoveryManifest): DiscoveryResult`
is exported, and that `DiscoveryResult` is
`{ status: "resolved"; graph: RepositoryOccurrence[] } | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] }`.
Also confirms the exact `RepositoryOccurrence` object shape built at
repositoryDiscovery.ts:109-122 (`occurrenceId`, `checkoutPath`,
`parentOccurrenceId`, `pathInParent`, `gitlinkOid`, `depth`, `originUrl`,
`baseBranch`, `baseOid`, `operationBranch`, `childOccurrenceIds`,
`testState`), and that when an `existing` occurrence entry has a non-empty
`baseBranch`, that `baseBranch`/`baseOid` are **preserved** across a
re-walk (repositoryDiscovery.ts:92-94) while `checkoutPath`,
`originUrl`, `depth`, and `gitlinkOid` are **freshly recomputed** from the
`rootPath` passed to `discoverRepositoryTree` on this call
(repositoryDiscovery.ts:109-122), and `operationBranch`/`childOccurrenceIds`/
`testState` are preserved from `existing` (repositoryDiscovery.ts:119-121).
This is why a `DiscoveryManifest` whose `repositoryManifest.occurrences`
already carries the correct `baseBranch` (submodule source branch) and
`operationBranch` (task branch name) for each submodule path, called with
`rootPath` = the task's worktree path, yields a graph whose `checkoutPath`
values point into the worktree while `baseBranch`/`operationBranch` stay
correct — this is also exactly why the source `checkoutPath` values must be
captured from the manifest **before** this call, per "Source checkout
paths" above. Root occurrence resolution (`parentOccurrenceId === null`,
repositoryDiscovery.ts:95-98) never touches `resolutionManifest`; a
submodule occurrence only touches `resolutionManifest` when `existing` is
absent or its `baseBranch` is empty (repositoryDiscovery.ts:99-107) — so a
manifest that always pre-seeds submodule occurrences with a real
`baseBranch` never exercises the resolution path at all.

### `scripts/testPolicy.ts` — no edit

Read-only. Confirms `discoverTestPolicy(occurrenceId, checkoutPath, resolutionManifest): TestPolicyResult`
is exported, `TestPolicyResult` is
`{ status: "resolved"; policy: TestPolicy } | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] }`,
and `TestPolicy.completeSuiteCommand` is a runnable shell command string
(`"npm run test"` when `package.json` has a `"test"` script, testPolicy.ts:94).
Confirms the `resolutionManifest` parameter is only read/written
(testPolicy.ts:56,60) when a repo has no `"test"` script or an ambiguous
related-test script — both avoided in this task's own tests by giving every
fixture repo an unambiguous `package.json` with only a `"test"` script.

### `scripts/mergeTaskWorktrees.ts` — 2 edits

**Edit 1 — imports.** Add `execSync` (for running each layer's test command)
and four new type/value imports.

Current text, lines 1-12:
```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { runMergePipeline } from "./mergePipeline.ts";
import type { MergeOutcome, SubmoduleConflict } from "./mergePipeline.ts";
```

Becomes:
```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { runMergePipeline } from "./mergePipeline.ts";
import type { MergeOutcome, SubmoduleConflict } from "./mergePipeline.ts";
import { discoverRepositoryTree } from "./repositoryDiscovery.ts";
import type { DiscoveryManifest } from "./repositoryDiscovery.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { discoverTestPolicy } from "./testPolicy.ts";
import type { ResolutionManifest, ResolutionRequest } from "./resolutionRequests.ts";
```

`RepositoryOccurrence` is confirmed exported by `./repositoryManifest.ts`
because `repositoryDiscovery.ts` itself imports it from that exact path
(`import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";`).
`ResolutionManifest`/`ResolutionRequest` are confirmed exported by
`./resolutionRequests.ts` the same way, via repositoryDiscovery.ts's own
import of them from that path.

**Edit 2 — new function block.** Insert between `rebaseGroupOntoSource`'s
closing brace and `mergeGroupBranchIntoRepo`.

Current text, lines 171-173 (unchanged, used only as the insertion anchor):
```
        return { status: "conflicted", conflictedFilePaths };
    }
}

export function mergeGroupBranchIntoRepo(
```

Becomes:
```
        return { status: "conflicted", conflictedFilePaths };
    }
}

export type SubmoduleLayerOutcome =
    | { occurrenceId: string; checkoutPath: string; status: "no-op" }
    | { occurrenceId: string; checkoutPath: string; status: "rebased-and-tested" }
    | { occurrenceId: string; checkoutPath: string; status: "conflicted"; conflictedFilePaths: string[] }
    | { occurrenceId: string; checkoutPath: string; status: "cleanup-failed"; failureReason: string }
    | { occurrenceId: string; checkoutPath: string; status: "tests-failed"; testOutput: string }
    | { occurrenceId: string; checkoutPath: string; status: "untested"; resolutionRequests: ResolutionRequest[] }
    | { occurrenceId: string; checkoutPath: string; status: "source-sync-failed"; failureReason: string };

// "rebased-and-tested" also covers a layer whose own branch was already current but whose child gitlink changed.

export type SubmoduleLayerWalkReport = {
    completedLayers: SubmoduleLayerOutcome[];
    stoppedAt: SubmoduleLayerOutcome | null;
};

function testFailureOutput(error: unknown): string {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return [failure.stdout, failure.stderr].filter(Boolean).join("\n").trim() || failure.message || "test command failed";
}

// Fetches baseBranch fresh from the real source checkout, without touching whatever branch is checked out.
function fetchBaseBranchFromSource(checkoutPath: string, sourceCheckoutPath: string, baseBranch: string): void {
    git(checkoutPath, "fetch", sourceCheckoutPath, `${baseBranch}:${baseBranch}`);
}

// Which of occurrence's direct children have a gitlink in occurrence's tree that no longer matches their checked-out commit.
function changedChildGitlinkPaths(occurrence: RepositoryOccurrence, childrenByParentId: Map<string, RepositoryOccurrence[]>): string[] {
    const children = childrenByParentId.get(occurrence.occurrenceId) ?? [];
    return children
        .map((child) => child.pathInParent)
        .filter((pathInParent): pathInParent is string => pathInParent !== null)
        .filter((pathInParent) => git(occurrence.checkoutPath, "status", "--porcelain", "--", pathInParent).trim() !== "");
}

// Stages and commits the gitlink bump for every already-computed changed child path. No-op when the list is empty.
function recordRebasedChildGitlinks(occurrence: RepositoryOccurrence, changedChildPaths: string[]): void {
    if (changedChildPaths.length === 0) return;
    for (const pathInParent of changedChildPaths) git(occurrence.checkoutPath, "add", pathInParent);
    git(occurrence.checkoutPath, "commit", "-q", "-m", `record rebased submodule commit: ${changedChildPaths.join(", ")}`);
}

function rebaseAndTestSubmoduleLayer(
    occurrence: RepositoryOccurrence,
    sourceCheckoutPath: string,
    resolutionManifest: ResolutionManifest,
    childrenByParentId: Map<string, RepositoryOccurrence[]>,
): SubmoduleLayerOutcome {
    const { occurrenceId, checkoutPath, baseBranch, operationBranch } = occurrence;

    try {
        fetchBaseBranchFromSource(checkoutPath, sourceCheckoutPath, baseBranch);
    } catch (error) {
        return { occurrenceId, checkoutPath, status: "source-sync-failed", failureReason: gitErrorText(error) };
    }

    const aheadOfSource = unmergedCommitCount(checkoutPath, baseBranch, operationBranch);
    const behindSource = unmergedCommitCount(checkoutPath, operationBranch, baseBranch);
    const refsIdentical = aheadOfSource === 0 && behindSource === 0;
    const changedChildPaths = changedChildGitlinkPaths(occurrence, childrenByParentId);

    // Refs identical and no child gitlink changed: nothing for this layer to do at all.
    if (refsIdentical && changedChildPaths.length === 0) {
        return { occurrenceId, checkoutPath, status: "no-op" };
    }

    // Refs differ: rebase this layer's own branch. Refs identical but a child changed: skip the rebase entirely.
    if (!refsIdentical) {
        const rebaseOutcome = rebaseGroupOntoSource(checkoutPath, baseBranch);
        if (rebaseOutcome.status === "conflicted") {
            return { occurrenceId, checkoutPath, status: "conflicted", conflictedFilePaths: rebaseOutcome.conflictedFilePaths };
        }
        if (rebaseOutcome.status === "cleanup-failed") {
            return { occurrenceId, checkoutPath, status: "cleanup-failed", failureReason: rebaseOutcome.failureReason };
        }
    }

    // Either the rebase above just happened, or refs were identical but a child's gitlink still needs recommitting.
    recordRebasedChildGitlinks(occurrence, changedChildPaths);

    const testPolicyResult = discoverTestPolicy(occurrenceId, checkoutPath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { occurrenceId, checkoutPath, status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { occurrenceId, checkoutPath, status: "rebased-and-tested" };
    } catch (error) {
        return { occurrenceId, checkoutPath, status: "tests-failed", testOutput: testFailureOutput(error) };
    }
}

function groupChildrenByParentId(occurrences: RepositoryOccurrence[]): Map<string, RepositoryOccurrence[]> {
    const childrenByParentId = new Map<string, RepositoryOccurrence[]>();
    for (const occurrence of occurrences) {
        if (occurrence.parentOccurrenceId === null) continue;
        const siblings = childrenByParentId.get(occurrence.parentOccurrenceId) ?? [];
        siblings.push(occurrence);
        childrenByParentId.set(occurrence.parentOccurrenceId, siblings);
    }
    return childrenByParentId;
}

// Rebases each submodule deepest-first, testing every layer before moving up; stops on the first red layer.
export function rebaseSubmoduleLayersDeepestFirst(worktreePath: string, manifest: DiscoveryManifest): SubmoduleLayerWalkReport {
    const sourceCheckoutPathByOccurrenceId = new Map(
        manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence.checkoutPath]),
    );

    const discovery = discoverRepositoryTree(worktreePath, manifest);
    if (discovery.status === "needsResolution") {
        throw new Error(`repository tree discovery needs resolution for: ${discovery.resolutionRequests.map((request) => request.occurrenceId).join(", ")}`);
    }

    const submoduleOccurrences = discovery.graph.filter((occurrence) => occurrence.parentOccurrenceId !== null);
    const childrenByParentId = groupChildrenByParentId(submoduleOccurrences);
    const submoduleLayersDeepestFirst = [...submoduleOccurrences].sort((a, b) => b.depth - a.depth);

    const completedLayers: SubmoduleLayerOutcome[] = [];
    for (const occurrence of submoduleLayersDeepestFirst) {
        const sourceCheckoutPath = sourceCheckoutPathByOccurrenceId.get(occurrence.occurrenceId) ?? "";
        const outcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId);
        if (outcome.status !== "no-op" && outcome.status !== "rebased-and-tested") {
            return { completedLayers, stoppedAt: outcome };
        }
        completedLayers.push(outcome);
    }
    return { completedLayers, stoppedAt: null };
}

export function mergeGroupBranchIntoRepo(
```

Design notes settled during planning (so the implementer makes no discovery
of their own):

- `discoverRepositoryTree` always recomputes `depth` fresh from its own
  recursion parameter (repositoryDiscovery.ts:79,142, passed into the
  `RepositoryOccurrence` literal at repositoryDiscovery.ts:115), never from
  `existing.depth` — so a caller-supplied placeholder `depth` in the input
  manifest is harmless; only `baseBranch`/`baseOid`/`operationBranch`/
  `childOccurrenceIds`/`testState` are preserved from `existing`.
  `checkoutPath` is always freshly computed as `join(rootPath, relativePath)`
  (repositoryDiscovery.ts:85,111) — this is what makes calling
  `discoverRepositoryTree(worktreePath, manifest)` yield `checkoutPath`
  values inside the worktree while reusing the manifest's known
  `baseBranch`/`operationBranch`, and it is also why the walk must capture
  the manifest's incoming `checkoutPath` values (the real source checkouts)
  before making that call — see "Source checkout paths" above.
- `needsResolution` from `discoverRepositoryTree` is treated as a thrown
  error, not a reportable walk outcome: by construction, a manifest built for
  this call already carries a resolved `baseBranch` for every submodule
  occurrence (proven true in every test below), so reaching
  `needsResolution` here means the caller passed an unprepared manifest — an
  input-contract violation, not a normal rebase/test failure this task's
  spec asks to report per-layer.
- A layer's `baseBranch` ref is always freshly fetched from its source
  checkout immediately before that layer's no-op check and rebase, so both
  reflect the true current source tip rather than a possibly-stale local ref
  left over from worktree creation or an earlier lap. A fetch failure (e.g.
  the source checkout no longer exists, or is unreachable) is reported as
  `"source-sync-failed"` and stops the walk — it is treated the same as any
  other layer failure, never silently ignored.
- `refsIdentical` is decided by comparing **both directions**:
  `unmergedCommitCount(checkoutPath, baseBranch, operationBranch)` (commits
  on the task branch not yet on source) and the same call with the two
  branch arguments swapped (commits on source not yet on the task branch).
  Only when both are `0` are the branches identical. `refsIdentical` alone
  does **not** decide `"no-op"` — see the three-path rule below. A task
  branch that is merely behind a freshly-advanced source — the exact case a
  stale pre-fetch local ref would have hidden — has a non-zero "behind"
  count, so `refsIdentical` is false and it is rebased and tested like any
  other layer.
- `changedChildGitlinkPaths(occurrence, childrenByParentId)` runs before the
  no-op decision, not after a rebase: it lists every direct child occurrence
  whose `pathInParent` shows as dirty in `git status --porcelain` inside
  `occurrence.checkoutPath`, i.e. every child whose *already-checked-out*
  commit (children are processed first, deepest-first) disagrees with the
  gitlink this layer's tree currently records for it. This is exactly the
  case a rebased child leaves behind: a rebase of the *child's* branch does
  not touch the *parent's* already-existing commits, so a parent commit that
  recorded the child's pre-rebase gitlink still records that same
  (now-superseded) OID even before the parent does anything of its own. A
  child that was itself a `"no-op"` never advances, so it never shows dirty
  and never appears in this list.
- The walk function combines `refsIdentical` and `changedChildGitlinkPaths`
  into exactly three paths, in this order:
  1. **`refsIdentical` is true and `changedChildGitlinkPaths` is empty** —
     `"no-op"`. No rebase, no gitlink commit, no test run. This is the only
     path that returns `"no-op"`.
  2. **`refsIdentical` is true but `changedChildGitlinkPaths` is non-empty**
     — `rebaseGroupOntoSource` is skipped entirely (there is nothing of this
     layer's own to rebase), but `recordRebasedChildGitlinks` still stages
     and commits the changed gitlink(s), and this layer's own tests still
     run against that updated tree. The outcome is `"rebased-and-tested"`
     (or a failure status from the test run), never `"no-op"` — a deeper
     child's rebase must still propagate and be tested at this layer even
     though this layer's own branch needed no rebase.
  3. **`refsIdentical` is false** — `rebaseGroupOntoSource` runs first (a
     `"conflicted"`/`"cleanup-failed"` result from it returns immediately,
     before any gitlink commit or test run), then
     `recordRebasedChildGitlinks` stages and commits any changed child
     gitlinks (there may be none, if this layer has no submodule children —
     `recordRebasedChildGitlinks` is a no-op in that case), then this
     layer's tests run.
  In paths 2 and 3, `recordRebasedChildGitlinks` is called with the same
  `changedChildPaths` list computed before the no-op check — it is not
  recomputed after the rebase, since rebasing this layer's own branch does
  not change which of its children are dirty.
- `needsResolution` from `discoverTestPolicy` (i.e. `no-test-configuration`
  or an ambiguous related-test script) **is** modeled as a reportable
  `"untested"` outcome that stops the walk, per task-86-spec.md's "A repo
  returning no-test-configuration is UNTESTED, and untested is not green."
- `testFailureOutput` is new (not one of the reused primitives) because
  running and interpreting each layer's own test command is new behavior
  this task adds; it captures both `stdout` and `stderr` (unlike the
  existing `gitErrorText`, which only inspects `stderr` and would drop most
  test-runner failure output, since assertion/stack-trace output typically
  goes to stdout while `npm`'s own diagnostics go to stderr). Node's
  `execSync` throws an `Error` whose `.stdout`/`.stderr` are populated with
  the child process's captured output whenever `stdio` uses `"pipe"` and the
  command exits non-zero — this is documented `child_process` behavior, not
  something this task's tests need to independently prove beyond exercising
  it once (the fifth test below).

### `tests/mergeTaskWorktrees.test.ts` — 2 edits (imports, then 5 new tests)

**Edit 1 — imports.** Add `rebaseSubmoduleLayersDeepestFirst` to the existing
import from `mergeTaskWorktrees.ts`, add `RepositoryOccurrence` to the
existing `repositoryManifest.ts` import, and add two new type-only imports.

Current text, lines 11 and 14-20:
```
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
```
and
```
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    rebaseGroupOntoSource,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```

Becomes:
```
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest, type RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
```
and
```
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    rebaseGroupOntoSource,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```

Also insert, immediately after line 13 (`import type { ArchiveRequest } from "../scripts/taskArchival.ts";`)
and before line 14 (`import {`), these two new lines:
```
import type { DiscoveryManifest } from "../scripts/repositoryDiscovery.ts";
import type { ResolutionManifest } from "../scripts/resolutionRequests.ts";
```

**Edit 2 — test helpers.** Insert two small helpers right after the existing
`makeManifest` helper, before `makeTempRepoWithLocalSubmodule`.

Current text, lines 81-83:
```
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: [root, ...subOccurrences] };
}

function makeTempRepoWithLocalSubmodule(): string {
```

Becomes:
```
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: [root, ...subOccurrences] };
}

function makeOccurrence(
    occurrenceId: string,
    parentOccurrenceId: string | null,
    baseBranch: string,
    baseOid: string,
    operationBranch: string,
    sourceCheckoutPath: string,
): RepositoryOccurrence {
    return {
        occurrenceId,
        checkoutPath: sourceCheckoutPath,
        parentOccurrenceId,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "",
        baseBranch,
        baseOid,
        operationBranch,
        childOccurrenceIds: [],
        testState: "untested" as const,
    };
}

function emptyResolutionManifest(): ResolutionManifest {
    return { resolutionAnswers: {} } as unknown as ResolutionManifest;
}

function makeTempRepoWithLocalSubmodule(): string {
```

(`depth: 0` is a harmless placeholder — `discoverRepositoryTree` always
recomputes `depth` fresh from its own recursion, per the repositoryDiscovery.ts
notes above, never reading `existing.depth`. `checkoutPath: sourceCheckoutPath`
is not a placeholder: it is read by `rebaseSubmoduleLayersDeepestFirst`
*before* discovery overwrites it, as the path the new layer fetches
`baseBranch` from — see "Source checkout paths" above. Every call site below
passes the real, non-worktree checkout for that occurrence.)

`emptyResolutionManifest` uses `as unknown as ResolutionManifest` rather than
a literal fully-typed object because `ResolutionManifest`'s complete field
set was not read (out of scope for this task's owned files); only its
`resolutionAnswers: Record<string, string>` field is exercised, confirmed by
`repositoryDiscovery.ts`'s `resolutionManifest.resolutionAnswers[requestId]`
(line 65) and `testPolicy.ts`'s identical use (line 57). Every fixture below
is built so `resolutionAnswers` is never read or written at runtime (root
branch resolution never touches it; every submodule occurrence pre-seeds a
real `baseBranch` so `resolveOccurrenceBaseBranch` is never called; every
fixture repo's `package.json` has an unambiguous `"test"` script so
`discoverTestPolicy` never calls `recordResolutionRequest`) — the cast is
therefore safe at both compile time and run time for these tests.

**Edit 3 — five new tests.** Append at the end of the file, after the final
existing test's closing `});` (current last lines, 753-756):
```
    assert.equal(outcome.status, "cleanup-failed");
    if (outcome.status === "cleanup-failed") assert.match(outcome.failureReason, /abort also failed: fake abort failure/);
});
```
(unchanged — used only as the append anchor), add:
```

test("test_rebaseGroupOntoSourceRebasesABranchInsideASubmodule", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");

    writeFileSync(join(worktreeSubmodulePath, "vendor-work.txt"), "vendor work\n");
    git(worktreeSubmodulePath, "add", "vendor-work.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "vendor work");

    writeFileSync(join(mainSubmodulePath, "main-advance.txt"), "main advance\n");
    git(mainSubmodulePath, "add", "main-advance.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "advance main submodule");
    git(worktreeSubmodulePath, "fetch", mainSubmodulePath, `${submoduleSourceBranch}:${submoduleSourceBranch}`);

    const outcome = rebaseGroupOntoSource(worktreeSubmodulePath, submoduleSourceBranch);
    assert.deepEqual(outcome, { status: "rebased-clean" });
    assert.doesNotThrow(() => git(worktreeSubmodulePath, "merge-base", "--is-ancestor", submoduleSourceBranch, "HEAD"));
});

test("test_rebaseSubmoduleLayersDeepestFirstTreatsASubmoduleAlreadyOnItsSourceTipAsANoOp", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const submoduleOperationBranch = currentBranchName(worktreeSubmodulePath);

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", submoduleSourceBranch, submoduleBaseOid, submoduleOperationBranch, mainSubmodulePath)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(group.worktree, manifest);

    assert.deepEqual(report.completedLayers, [{ occurrenceId: "vendor", checkoutPath: worktreeSubmodulePath, status: "no-op" }]);
    assert.equal(report.stoppedAt, null);
});

test("test_rebaseSubmoduleLayersDeepestFirstRebasesTheDeepestSubmoduleBeforeItsContainerAndRecordsItsRebasedGitlink", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const testScriptPackageJson = JSON.stringify({ scripts: { test: "true" } });

    const innerOrigin = makeTempRepoWithCommit();
    writeFileSync(join(innerOrigin, "package.json"), testScriptPackageJson);
    git(innerOrigin, "add", "package.json");
    git(innerOrigin, "commit", "-q", "-m", "add test script");
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(join(vendorOrigin, "package.json"), testScriptPackageJson);
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add test script");
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");
    const innerTaskCommitBeforeRebase = git(innerCheckoutPath, "rev-parse", "HEAD").trim();

    // Reproduce the real starting state: parent's task branch already records child's pre-rebase gitlink.
    git(vendorCheckoutPath, "add", "inner");
    git(vendorCheckoutPath, "commit", "-q", "-m", "bump inner to task-1 work");

    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    // Advance both source branches independently, after the task branches already diverged.
    writeFileSync(join(innerOrigin, "inner-source-advance.txt"), "inner source advance\n");
    git(innerOrigin, "add", "inner-source-advance.txt");
    git(innerOrigin, "commit", "-q", "-m", "advance inner source");
    const innerSourceTip = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    writeFileSync(join(vendorOrigin, "vendor-source-advance.txt"), "vendor source advance\n");
    git(vendorOrigin, "add", "vendor-source-advance.txt");
    git(vendorOrigin, "commit", "-q", "-m", "advance vendor source");
    const vendorSourceTip = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor/inner", "vendor"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested", "rebased-and-tested"]);

    // Both task branches were rebased onto their freshly-fetched (post-advance) source tips.
    assert.doesNotThrow(() => git(innerCheckoutPath, "merge-base", "--is-ancestor", innerSourceTip, "HEAD"));
    assert.doesNotThrow(() => git(vendorCheckoutPath, "merge-base", "--is-ancestor", vendorSourceTip, "HEAD"));

    const innerTaskCommitAfterRebase = git(innerCheckoutPath, "rev-parse", "task-1").trim();
    assert.notEqual(innerTaskCommitAfterRebase, innerTaskCommitBeforeRebase);

    // vendor's task-1 branch now records inner's rebased commit, not its pre-rebase one.
    const vendorRecordedInnerOid = git(vendorCheckoutPath, "rev-parse", "task-1:inner").trim();
    assert.equal(vendorRecordedInnerOid, innerTaskCommitAfterRebase);
});

test("test_rebaseSubmoduleLayersDeepestFirstRecordsAndTestsAContainerWhoseOwnRefsAreIdenticalButWhoseChildGitlinkChanged", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const testScriptPackageJson = JSON.stringify({ scripts: { test: "true" } });

    const innerOrigin = makeTempRepoWithCommit();
    writeFileSync(join(innerOrigin, "package.json"), testScriptPackageJson);
    git(innerOrigin, "add", "package.json");
    git(innerOrigin, "commit", "-q", "-m", "add test script");
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(join(vendorOrigin, "package.json"), testScriptPackageJson);
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add test script");
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    // vendor's task-1 gets no commit of its own: it stays at vendorSourceBranch's tip, refs trivially identical.
    const vendorTaskCommitBeforeWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.equal(vendorTaskCommitBeforeWalk, vendorBaseOid);

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");
    const innerTaskCommitBeforeRebase = git(innerCheckoutPath, "rev-parse", "HEAD").trim();

    // Only inner's source advances; vendor's own source is left untouched, so vendor's task-1 and source stay identical.
    writeFileSync(join(innerOrigin, "inner-source-advance.txt"), "inner source advance\n");
    git(innerOrigin, "add", "inner-source-advance.txt");
    git(innerOrigin, "commit", "-q", "-m", "advance inner source");
    const innerSourceTip = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    // Confirm the precondition the fix targets: vendor's own task-1 and source are identical before the walk runs.
    assert.equal(git(vendorCheckoutPath, "rev-list", "--count", `${vendorSourceBranch}..task-1`).trim(), "0");
    assert.equal(git(vendorCheckoutPath, "rev-list", "--count", `task-1..${vendorSourceBranch}`).trim(), "0");

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor/inner", "vendor"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested", "rebased-and-tested"]);

    const innerTaskCommitAfterRebase = git(innerCheckoutPath, "rev-parse", "task-1").trim();
    assert.notEqual(innerTaskCommitAfterRebase, innerTaskCommitBeforeRebase);
    assert.doesNotThrow(() => git(innerCheckoutPath, "merge-base", "--is-ancestor", innerSourceTip, "HEAD"));

    // vendor's own refs were identical, yet it still recorded inner's commit and tested, not "no-op".
    const vendorTaskCommitAfterWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.notEqual(vendorTaskCommitAfterWalk, vendorTaskCommitBeforeWalk);
    const vendorRecordedInnerOid = git(vendorCheckoutPath, "rev-parse", "task-1:inner").trim();
    assert.equal(vendorRecordedInnerOid, innerTaskCommitAfterRebase);
});

test("test_rebaseSubmoduleLayersDeepestFirstStopsAndReportsBothOutputStreamsWhenALayersTestsFailWithoutProcessingItsContainer", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const passingTestPackageJson = JSON.stringify({ scripts: { test: "true" } });

    const innerOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(innerOrigin, "test-fail.js"),
        "console.log('layer-stdout-marker');\nconsole.error('layer-stderr-marker');\nprocess.exit(1);\n",
    );
    writeFileSync(join(innerOrigin, "package.json"), JSON.stringify({ scripts: { test: "node test-fail.js" } }));
    git(innerOrigin, "add", "test-fail.js", "package.json");
    git(innerOrigin, "commit", "-q", "-m", "add failing test script");
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(join(vendorOrigin, "package.json"), passingTestPackageJson);
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add test script");
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");

    const vendorTaskCommitBeforeWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.deepEqual(report.completedLayers, []);
    assert.equal(report.stoppedAt !== null && report.stoppedAt.occurrenceId, "vendor/inner");
    assert.equal(report.stoppedAt !== null && report.stoppedAt.status, "tests-failed");
    if (report.stoppedAt !== null && report.stoppedAt.status === "tests-failed") {
        assert.match(report.stoppedAt.testOutput, /layer-stdout-marker/);
        assert.match(report.stoppedAt.testOutput, /layer-stderr-marker/);
    }

    // vendor (inner's container) was never rebased: its task-1 branch is exactly as it was.
    const vendorTaskCommitAfterWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.equal(vendorTaskCommitAfterWalk, vendorTaskCommitBeforeWalk);
});
```

Fixture mechanics settled during planning, verified empirically against the
real `git` on this machine (no guessing):

- `git init` on this machine defaults to branch `master`; every branch name
  used above is read back via `currentBranchName(...)`, never hardcoded, so
  this is irrelevant to correctness either way.
- `git submodule update --init --recursive` leaves a **nested** (depth-2)
  submodule in detached `HEAD`, even though the depth-1 submodule created by
  `git submodule add` ends up on a named branch. The third, fourth, and
  fifth tests (every test built on the nested `vendor`/`vendor/inner`
  fixture) therefore explicitly run `git checkout <sourceBranch>` in both
  `vendorCheckoutPath` and `innerCheckoutPath` before branching `task-1`, so
  neither is ever processed while detached.
- A submodule with new commits shows as a dirty/modified entry in its
  parent's `git status` (confirmed: `git -C <vendor> status --porcelain`
  shows `M inner` once `inner`'s checked-out commit has advanced past
  `vendor`'s recorded gitlink), but this does **not** block `git rebase`
  inside `vendor`'s own checkout — confirmed by running the exact sequence
  (`checkout -b task-1` in both, forward-commit both, then `git -C vendor
  rebase master`) end to end: `Successfully rebased and updated
  refs/heads/task-1.`. This is the same mismatch `recordRebasedChildGitlinks`
  detects and commits: the third test's `vendor` layer rebases carrying a
  commit that recorded `inner`'s pre-rebase OID, while `vendor`'s working
  tree already has `inner` checked out at its post-rebase OID (rebased
  first, since children are processed deepest-first) — exactly the dirty
  state the function stages and commits before `vendor`'s own tests run.
- `createWorktreeForGroup(repoRoot, { groupId: 1, ... })` (used by the
  existing `makeGroup` helper) was run directly to confirm: the resulting
  worktree's submodule checkout ends up on a branch literally named
  `task-1` (not just a `group-1`-flavored name), that checkout already has
  **both** the source branch (`master`) and `task-1` as local refs, and
  `git rev-list --count master..task-1` is `0` immediately after creation —
  confirming the second test's "no-op" precondition holds (in both
  directions) with no extra setup.
- `npm run test` against a `package.json` containing only
  `{"scripts":{"test":"true"}}` (no `name`/`version` field) runs and exits
  `0` with no network/install step — confirmed by running it directly in two
  such directories.
- Fetching the advanced source branch from a submodule's *main* checkout
  (not its origin) into the worktree's submodule checkout via `git fetch
  <mainSubmodulePath> <branch>:<branch>`, then rebasing onto that branch
  name, is the exact pattern the file already uses for the reverse direction
  in `mergeSubmoduleBranchIntoRepo` (line 215); confirmed working for the
  first test's direction by running the equivalent sequence directly. The
  new `fetchBaseBranchFromSource` helper applies this identical, already-
  confirmed pattern inside the walk itself, fetching each layer's
  `baseBranch` from its captured source `checkoutPath` immediately before
  that layer's no-op check.
- A `package.json` `"test"` script of `"node test-fail.js"`, where
  `test-fail.js` writes one line to `stdout`, one line to `stderr`, and
  exits `1`, causes `execSync` (called with `stdio: ["ignore", "pipe",
  "pipe"]`) to throw an `Error` whose `.stdout` and `.stderr` fields contain
  those two lines respectively — this is `child_process`'s documented
  contract for a non-zero exit under piped `stdio`, exercised directly by
  the fifth test via `testFailureOutput`'s output.
- The new fourth test (identical container refs, changed child gitlink)
  reuses the third test's fixture-construction sequence up through
  branching both checkouts onto `task-1`, but — unlike the third test —
  never commits anything onto `vendor`'s own `task-1` branch (no "bump
  inner" commit, no `vendor-work.txt` commit) and never advances
  `vendorOrigin`. Only `innerCheckoutPath` gets new work, and only
  `innerOrigin` advances. `vendor`'s `task-1` therefore stays byte-equal to
  `vendorSourceBranch` (asserted both by `rev-parse` right after branching
  and by the explicit `git rev-list --count` checks right before the walk
  runs), while `vendor`'s *working tree* still ends up with `inner` dirty
  once inner is rebased — because `vendor`'s committed tree recorded
  `inner` at `innerBaseOid` (from `vendorOrigin`'s original "add inner
  submodule" commit) and never anything newer. This is deliberately
  different from the third test's setup, where the pre-existing "bump
  inner to task-1 work" commit would itself have put `vendor`'s `task-1`
  ahead of `vendorSourceBranch` and made `refsIdentical` false — exactly
  the case this new test must avoid, since it is testing the
  `refsIdentical`-but-child-changed path, not the ordinary rebase path.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

1. `npx tsc --noEmit` — expect no errors (this is the project's own
   established typecheck invocation, seen throughout tests/mergeTaskWorktrees.test.ts
   as `typecheckCommand: "npx tsc --noEmit"`).
2. `node --test tests/mergeTaskWorktrees.test.ts` — expect all tests
   (existing plus the 5 new ones: `test_rebaseGroupOntoSourceRebasesABranchInsideASubmodule`,
   `test_rebaseSubmoduleLayersDeepestFirstTreatsASubmoduleAlreadyOnItsSourceTipAsANoOp`,
   `test_rebaseSubmoduleLayersDeepestFirstRebasesTheDeepestSubmoduleBeforeItsContainerAndRecordsItsRebasedGitlink`,
   `test_rebaseSubmoduleLayersDeepestFirstRecordsAndTestsAContainerWhoseOwnRefsAreIdenticalButWhoseChildGitlinkChanged`,
   `test_rebaseSubmoduleLayersDeepestFirstStopsAndReportsBothOutputStreamsWhenALayersTestsFailWithoutProcessingItsContainer`)
   to pass, 0 failures.
3. `node --test tests/` — expect no regressions in the rest of the suite
   (this is the file's own documented run command, from its header comment).
