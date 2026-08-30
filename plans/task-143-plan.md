# Task 143 plan: rebase the parent task-N branch and resolve gitlink conflicts

## Scope

Owned files: `scripts/mergeTaskWorktrees.ts`, `tests/mergeTaskWorktrees.test.ts`. Both are edited. No other file is touched.

Two changes to `scripts/mergeTaskWorktrees.ts`:

1. Extend `rebaseGroupOntoSource` with a third, optional, defaulted parameter `submodulePathsAllowedToConflict: string[] = []`. After the initial `git rebase` fails, loop: on each round, collect the currently-conflicted paths; if every one of them is in the allowed list, stage them (picking up whatever commit is already checked out at each path — the already-rebased submodule commit from task 142's layer walk) and run `git rebase --continue`, then either return `rebased-clean` (continue succeeded) or loop again to inspect the next round's conflicts (continue itself failed because a later commit in the same rebase hit another conflict). If any conflicted path in a round falls outside the allowed list, abort and report exactly as today. When the list is empty (the default), the first round can never have "every conflicted path allowed" (an empty list contains nothing), so the loop's first iteration always takes the abort-and-report path — same outcome as today for every existing caller.
2. Add a new exported function `rebaseParentOntoSourceAndTest` that calls the extended `rebaseGroupOntoSource` for the parent's own worktree, and — only once that rebase is clean — discovers and runs the parent's own test command via `discoverTestPolicy`, reporting `untested` (not a pass) when no test configuration is found. No merging happens; this task only rebases and tests.

Both `resolveGitlinkConflicts` and `rebaseAndTestSubmoduleLayer`/`rebaseSubmoduleLayersDeepestFirst` (task 142's functions) are left untouched — the extended `rebaseGroupOntoSource` replaces the need to call `resolveGitlinkConflicts` during a rebase, because `resolveGitlinkConflicts`'s `git commit --no-edit` / `git merge --abort` are merge grammar, not rebase grammar (this is the reviewer-decided resolution recorded in brief-143.md and must not be re-litigated).

## Why these two changes are sufficient

- `rebaseAndTestSubmoduleLayer` (task 142) never processes the root occurrence — `rebaseSubmoduleLayersDeepestFirst` filters to `occurrence.parentOccurrenceId !== null` before the walk. The root/parent is untouched by task 142's code, which is exactly the gap task 143 fills.
- The root occurrence's worktree (`group.worktree`) is a `git worktree` of the same repository as the source branch, so no "fetch base branch from a separate source checkout" step is needed for the parent the way `fetchBaseBranchFromSource` is needed for submodule occurrences with a distinct source checkout path — the source branch ref is already visible locally, `git rebase sourceBranch` resolves it directly.
- A gitlink conflict at the parent level arises the same way it does for a merge (proven already by the existing test `test_resolveGitlinkConflictsAutoResolvesASubmodulePointerConflict`): the parent's task-N branch recorded a submodule pointer at some commit, the parent's own source branch independently recorded the submodule pointer at a *different* commit (e.g. from an earlier merge in this same run, or an unrelated concurrent change), and rebasing produces a three-way conflict on that gitlink line. This was verified directly in a throwaway sandbox (see "What was verified in a sandbox" below) before writing this plan: the conflict occurs, `git add <path>` (with the submodule already checked out at the desired resolution commit) plus `git rebase --continue` resolves it cleanly with **no editor invocation and no hang**, even with stdin closed/ignored — matching how the `git()` helper in this file invokes git (`stdio: ["ignore", "pipe", "pipe"]`).
- A single rebase can carry more than one commit, so a permitted gitlink conflict can recur on a later commit even after an earlier one was resolved and `git rebase --continue` was run. `rebaseGroupOntoSource` must therefore loop — resolve a round, attempt to continue, and if the continue attempt itself fails because the rebase is still in progress with a fresh conflict, go around again — rather than assuming one round of staging is enough.

## Edit 1 — `scripts/mergeTaskWorktrees.ts`: extend `rebaseGroupOntoSource`

Current text (lines 194–230):

```ts
export function rebaseGroupOntoSource(worktreePath: string, sourceBranch: string): RebaseOutcome {
    try {
        git(worktreePath, "rebase", sourceBranch);
        return { status: "rebased-clean" };
    } catch (rebaseError) {
        const originalReason = gitErrorText(rebaseError);

        let inProgress: boolean;
        try {
            inProgress = rebaseInProgress(worktreePath);
        } catch (stateError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(stateError), abortFailure) };
        }

        if (!inProgress) return { status: "cleanup-failed", failureReason: originalReason };

        let conflictedFilePaths: string[];
        try {
            conflictedFilePaths = collectConflictedRebasePaths(worktreePath);
        } catch (collectionError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(collectionError), abortFailure) };
        }

        const abortResult = abortRebase(worktreePath);
        if (!abortResult.aborted) {
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, `abort also failed: ${abortResult.failureReason}`) };
        }

        if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: originalReason };

        return { status: "conflicted", conflictedFilePaths };
    }
}
```

New text — replace the whole block above with:

```ts
export function rebaseGroupOntoSource(
    worktreePath: string,
    sourceBranch: string,
    submodulePathsAllowedToConflict: string[] = [],
): RebaseOutcome {
    let pendingReason: string;
    try {
        git(worktreePath, "rebase", sourceBranch);
        return { status: "rebased-clean" };
    } catch (rebaseError) {
        pendingReason = gitErrorText(rebaseError);
    }

    while (true) {
        let inProgress: boolean;
        try {
            inProgress = rebaseInProgress(worktreePath);
        } catch (stateError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, gitErrorText(stateError), abortFailure) };
        }

        if (!inProgress) return { status: "cleanup-failed", failureReason: pendingReason };

        let conflictedFilePaths: string[];
        try {
            conflictedFilePaths = collectConflictedRebasePaths(worktreePath);
        } catch (collectionError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, gitErrorText(collectionError), abortFailure) };
        }

        // Every conflict in this round is an allowed submodule gitlink: stage the already-rebased commits and continue instead of aborting.
        const allConflictsAreAllowedSubmodules =
            conflictedFilePaths.length > 0 && conflictedFilePaths.every((path) => submodulePathsAllowedToConflict.includes(path));

        if (!allConflictsAreAllowedSubmodules) {
            const abortResult = abortRebase(worktreePath);
            if (!abortResult.aborted) {
                return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, `abort also failed: ${abortResult.failureReason}`) };
            }

            if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: pendingReason };

            return { status: "conflicted", conflictedFilePaths };
        }

        try {
            for (const path of conflictedFilePaths) git(worktreePath, "add", path);
        } catch (stagingError) {
            // A failed `git add` leaves the same conflict in place: abort immediately, never loop on it.
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, gitErrorText(stagingError), abortFailure) };
        }

        try {
            git(worktreePath, "rebase", "--continue");
            return { status: "rebased-clean" };
        } catch (continueError) {
            // Only a failed `git rebase --continue` loops: it may mean a later commit hit another conflict.
            pendingReason = combineFailureReasons(pendingReason, gitErrorText(continueError));
        }
    }
}
```

With the default empty array, the first round always has `conflictedFilePaths.length > 0` (or the pre-existing `!inProgress`/`conflictedFilePaths.length === 0` cleanup-failed paths, unchanged) and `submodulePathsAllowedToConflict.includes(path)` is never true for an empty array, so `allConflictsAreAllowedSubmodules` is `false` and execution takes the abort-and-report branch on the very first iteration — the same single pass through the same logic as today, producing the same `RebaseOutcome`. This keeps `test_rebaseGroupOntoSourceReportsConflictedPathsAndLeavesNoRebaseInProgress` and `test_rebaseGroupOntoSourceReportsCleanupFailedWhenAbortFails` (both call the function with 2 arguments) passing unchanged.

When `submodulePathsAllowedToConflict` is non-empty and every conflicted path in a round is in it, staging and continuing are two separate try/catch blocks, not one, so their failures are handled differently. First, each conflicted path is staged with `git(worktreePath, "add", path)` inside its own try. If any of those `git add` calls throws, the same conflict is still sitting there unresolved — looping would just hit it again — so the catch calls `abortRebase` immediately and returns `cleanup-failed`, with `failureReason` built by `combineFailureReasons(pendingReason, gitErrorText(stagingError), abortFailure)` (the third argument is `null` when the abort itself succeeds), exactly the pattern the function's other cleanup-failed branches already use. This path never loops. Only once every path stages cleanly does the function attempt `git(worktreePath, "rebase", "--continue")`, wrapped in its own second try. If that succeeds, the function returns `rebased-clean` immediately. If it fails because the rebase carried another commit that reintroduces a conflict, that catch block records the failure reason via `combineFailureReasons(pendingReason, gitErrorText(continueError))` and the `while (true)` loop goes back to the top, re-checks `rebaseInProgress`, and re-collects the new round's conflicted paths — so a multi-commit rebase with more than one permitted gitlink conflict is still resolved round by round. If `git rebase --continue` fails for a reason that leaves no rebase in progress, the next loop iteration's `!inProgress` check returns `cleanup-failed` with the accumulated reason, exactly like the pre-existing "abort already happened underneath us" cleanup-failed path.

## Edit 2 — `scripts/mergeTaskWorktrees.ts`: add `rebaseParentOntoSourceAndTest`

Current text (lines 305–309, end of `rebaseSubmoduleLayersDeepestFirst` through the start of `mergeGroupBranchIntoRepo`):

```ts
    return { completedLayers, stoppedAt: null };
}

export function mergeGroupBranchIntoRepo(
```

New text — insert the new type and function between the two, so the block becomes:

```ts
    return { completedLayers, stoppedAt: null };
}

export type ParentRebaseOutcome =
    | { status: "rebased-and-tested" }
    | { status: "conflicted"; conflictedFilePaths: string[] }
    | { status: "cleanup-failed"; failureReason: string }
    | { status: "tests-failed"; testOutput: string }
    | { status: "untested"; resolutionRequests: ResolutionRequest[] };

// Rebases the parent's task-N branch onto its source tip, resolving submodule gitlink conflicts, then tests it.
export function rebaseParentOntoSourceAndTest(
    occurrenceId: string,
    worktreePath: string,
    sourceBranch: string,
    submodulePaths: string[],
    resolutionManifest: ResolutionManifest,
): ParentRebaseOutcome {
    const rebaseOutcome = rebaseGroupOntoSource(worktreePath, sourceBranch, submodulePaths);
    if (rebaseOutcome.status === "conflicted") {
        return { status: "conflicted", conflictedFilePaths: rebaseOutcome.conflictedFilePaths };
    }
    if (rebaseOutcome.status === "cleanup-failed") {
        return { status: "cleanup-failed", failureReason: rebaseOutcome.failureReason };
    }

    const testPolicyResult = discoverTestPolicy(occurrenceId, worktreePath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { status: "rebased-and-tested" };
    } catch (error) {
        return { status: "tests-failed", testOutput: testFailureOutput(error) };
    }
}

export function mergeGroupBranchIntoRepo(
```

No new imports are needed for this edit: `execSync`, `discoverTestPolicy`, `ResolutionManifest`, `ResolutionRequest`, and `testFailureOutput` are all already imported/defined earlier in the file (lines 2, 16, 17, and the `testFailureOutput` function above `rebaseAndTestSubmoduleLayer`).

`rebaseAndTestSubmoduleLayer` and `rebaseSubmoduleLayersDeepestFirst` (task 142's functions, lines 220–307) are not modified — they still call `rebaseGroupOntoSource(checkoutPath, baseBranch)` with two arguments, which is unaffected by the new default parameter.

## Edit 3 — `tests/mergeTaskWorktrees.test.ts`: import the new export and the no-test-configuration reason constant

Current text (lines 16–23):

```ts
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    rebaseGroupOntoSource,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```

New text:

```ts
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    rebaseGroupOntoSource,
    rebaseParentOntoSourceAndTest,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
import { REASON_NO_TEST_CONFIGURATION } from "../scripts/testPolicy.ts";
```

## Edit 4 — `tests/mergeTaskWorktrees.test.ts`: add six new tests

Current text (lines 1061–1066, the end of the file, closing the last existing test):

```ts

    // vendor (inner's container) was never rebased: its task-1 branch is exactly as it was.
    const vendorTaskCommitAfterWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.equal(vendorTaskCommitAfterWalk, vendorTaskCommitBeforeWalk);
});
```

New text — keep that block exactly as-is and append the following six tests immediately after it (before end of file):

```ts

    // vendor (inner's container) was never rebased: its task-1 branch is exactly as it was.
    const vendorTaskCommitAfterWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.equal(vendorTaskCommitAfterWalk, vendorTaskCommitBeforeWalk);
});

test("test_rebaseParentOntoSourceAndTestResolvesAnAllowedGitlinkConflictAndReportsRebasedAndTested", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const baseBranch = currentBranchName(repoRoot);
    const submoduleBaseBranch = currentBranchName(mainSubmodulePath);

    git(mainSubmodulePath, "checkout", "-b", "branch-a");
    writeFileSync(join(mainSubmodulePath, "a.txt"), "a\n");
    git(mainSubmodulePath, "add", "a.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "a");
    const commitA = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", submoduleBaseBranch);
    git(mainSubmodulePath, "checkout", "-b", "branch-b");
    writeFileSync(join(mainSubmodulePath, "b.txt"), "b\n");
    git(mainSubmodulePath, "add", "b.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "b");
    const commitB = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", commitA);
    git(repoRoot, "checkout", "-b", "feature");
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "feature submodule pointer");

    git(repoRoot, "checkout", baseBranch);
    git(mainSubmodulePath, "checkout", commitB);
    git(repoRoot, "add", "vendor");
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoRoot, "add", "package.json");
    git(repoRoot, "commit", "-q", "-m", "base submodule pointer and test config");

    git(repoRoot, "checkout", "feature");
    // Intended resolution: keep feature's already-rebased submodule commit.
    git(mainSubmodulePath, "checkout", commitA);

    const outcome = rebaseParentOntoSourceAndTest("root", repoRoot, baseBranch, ["vendor"], emptyResolutionManifest());

    assert.deepEqual(outcome, { status: "rebased-and-tested" });
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-merge")), false);
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-apply")), false);
    const rootGitlinkOid = git(repoRoot, "ls-tree", "feature", "vendor").trim().split(/\s+/)[2];
    assert.equal(rootGitlinkOid, commitA);
});

test("test_rebaseParentOntoSourceAndTestRebasesThenRunsTheParentsOwnTestCommandAndReportsRebasedAndTested", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoRoot, "add", "package.json");
    git(repoRoot, "commit", "-q", "-m", "add test script");
    const sourceBranch = currentBranchName(repoRoot);

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "group-work.txt"), "group work\n");
    git(group.worktree, "add", "group-work.txt");
    git(group.worktree, "commit", "-q", "-m", "group work");

    writeFileSync(join(repoRoot, "main-advance.txt"), "main advance\n");
    git(repoRoot, "add", "main-advance.txt");
    git(repoRoot, "commit", "-q", "-m", "advance main");

    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest());

    assert.deepEqual(outcome, { status: "rebased-and-tested" });
    assert.doesNotThrow(() => git(group.worktree, "merge-base", "--is-ancestor", sourceBranch, "HEAD"));
});

test("test_rebaseParentOntoSourceAndTestReportsUntestedWhenTheParentHasNoTestConfiguration", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest());

    assert.equal(outcome.status, "untested");
});

test("test_rebaseSubmoduleLayersDeepestFirstRunsTheSubmodulesOwnTestCommandNotTheParents", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    writeFileSync(
        join(rootPath, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','parent-ran')\"" } }),
    );
    git(rootPath, "add", "package.json");
    git(rootPath, "commit", "-q", "-m", "add parent test script");

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(vendorOrigin, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','submodule-ran')\"" } }),
    );
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add submodule test script");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested"]);
    assert.equal(readFileSync(join(vendorCheckoutPath, "test-marker.txt"), "utf8"), "submodule-ran");
});

test("test_rebaseSubmoduleLayersDeepestFirstReportsUntestedWhenTheSubmoduleHasNoTestConfigurationEvenThoughTheParentDoes", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    writeFileSync(join(rootPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(rootPath, "add", "package.json");
    git(rootPath, "commit", "-q", "-m", "add parent test script");

    const vendorOrigin = makeTempRepoWithCommit();
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.completedLayers.length, 0);
    assert.notEqual(report.stoppedAt, null);
    assert.equal(report.stoppedAt?.status, "untested");
    const untestedOutcome = report.stoppedAt as { status: "untested"; resolutionRequests: { reason: string }[] };
    assert.equal(untestedOutcome.resolutionRequests[0].reason, REASON_NO_TEST_CONFIGURATION);
});

test("test_rebaseGroupOntoSourceAbortsAndReportsCleanupFailedWhenStagingAnAllowedConflictFails", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const baseBranch = currentBranchName(repoRoot);
    const submoduleBaseBranch = currentBranchName(mainSubmodulePath);

    git(mainSubmodulePath, "checkout", "-b", "branch-a");
    writeFileSync(join(mainSubmodulePath, "a.txt"), "a\n");
    git(mainSubmodulePath, "add", "a.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "a");
    const commitA = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", submoduleBaseBranch);
    git(mainSubmodulePath, "checkout", "-b", "branch-b");
    writeFileSync(join(mainSubmodulePath, "b.txt"), "b\n");
    git(mainSubmodulePath, "add", "b.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "b");
    const commitB = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", commitA);
    git(repoRoot, "checkout", "-b", "feature");
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "feature submodule pointer");

    git(repoRoot, "checkout", baseBranch);
    git(mainSubmodulePath, "checkout", commitB);
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "base submodule pointer");

    git(repoRoot, "checkout", "feature");
    // Delete the submodule's working directory so `git add vendor` has no path to stage and throws.
    execFileSync("rm", ["-rf", mainSubmodulePath]);

    const outcome = rebaseGroupOntoSource(repoRoot, baseBranch, ["vendor"]);

    assert.equal(outcome.status, "cleanup-failed");
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-merge")), false);
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-apply")), false);
});
```

`emptyResolutionManifest`, `makeTempRepoWithCommit`, `makeTempRepoWithLocalSubmodule`, `makeGroup`, `makeOccurrence`, `currentBranchName`, `existsSync`, `readFileSync`, `join`, `writeFileSync`, `REPOSITORY_MANIFEST_VERSION`, `DiscoveryManifest` are all already declared/imported in this file — no further import changes needed beyond Edit 3. `readFileSync` is already imported at the top of the test file (line 5). `execFileSync`, used by test 6 to delete the submodule directory, is likewise already imported at the top of the test file (line 4) — no new import required.

### Why these six tests are the right ones, nothing more

- Test 1 (`test_rebaseParentOntoSourceAndTestResolvesAnAllowedGitlinkConflictAndReportsRebasedAndTested`) satisfies the task's stated test requirement — "assert the rebased parent's gitlinks match the rebased submodule commits from step 1" — through the actual entry point an implementer/orchestrator would call (`rebaseParentOntoSourceAndTest`), not just the lower-level `rebaseGroupOntoSource` primitive, so it also proves the allowed-paths list is threaded through correctly. It reuses the exact three-way-conflict construction already proven by the existing (unmodified) test `test_resolveGitlinkConflictsAutoResolvesASubmodulePointerConflict`, swapped from merge to rebase. `commitA` (checked out in the submodule before the call) stands in for "the already-rebased submodule commit from task 142"; the assertion that `feature`'s tree entry for `vendor` equals `commitA` is exactly "the rebased parent's gitlink equals the rebased submodule commit," and `outcome` being `rebased-and-tested` proves the parent's own test command ran after the conflict was resolved.
- Tests 2 and 3 are the minimum coverage for `rebaseParentOntoSourceAndTest`'s non-conflict path: one proves the parent's own tests run and must pass after a clean rebase with no conflicts at all, one proves a repository with no test configuration is reported `untested`, not green.
- Tests 4 and 5 are the brief's two explicitly required "TEST —" bullets under the chain goal: one proves `discoverTestPolicy`, run inside a submodule via `rebaseSubmoduleLayersDeepestFirst` (task 142's already-existing walker), finds and runs the submodule's own test command rather than the parent's — proven by giving parent and submodule distinct, differently-named marker-writing commands and asserting only the submodule's marker was written where the submodule's own test ran; the other proves a submodule with no test configuration is reported `untested` with a `no-test-configuration` resolution request even when the parent has a working test configuration, so discovery does not fall back to the parent's. Both exercise `rebaseSubmoduleLayersDeepestFirst`/`rebaseAndTestSubmoduleLayer` (task 142's existing, unmodified functions) rather than adding new production code — this task's edits (`rebaseGroupOntoSource`'s new parameter, `rebaseParentOntoSourceAndTest`) do not touch submodule-level test discovery at all, so no source change to task 142's functions is needed to make these two tests pass; they document behavior that already exists but was previously unproven, per the brief.
- Test 6 (`test_rebaseGroupOntoSourceAbortsAndReportsCleanupFailedWhenStagingAnAllowedConflictFails`) is the fix codex required: it proves a failing `git add` on an allowed conflicted path aborts immediately and returns `cleanup-failed` rather than looping. It reuses the same three-way gitlink-conflict construction as test 1, but instead of letting `git add vendor` succeed, it deletes the submodule's working directory first so `git add vendor` has no path to stage and throws — forcing execution into the staging `catch` block rather than the continue `catch` block. The assertions (`outcome.status === "cleanup-failed"` and no `.git/rebase-merge`/`.git/rebase-apply` left behind) prove the abort ran and the function returned rather than looping back into the `while (true)`.

## What was verified in a sandbox before writing this plan

Ran a throwaway git-only reproduction (no repository files touched) of: two branches independently changing a submodule's recorded commit, rebasing one onto the other, hitting a real gitlink conflict, then `git add <path>` (with the submodule checked out at the desired resolution) followed by `git rebase --continue` with stdin closed. Result: conflict occurs exactly as expected (`git status --porcelain` shows `UU vendor`, `git diff --name-only --diff-filter=U` shows `vendor`), `git rebase --continue` succeeds with exit code 0 and **no editor prompt** even with stdin closed (matching this file's `git()` helper, which runs with `stdio: ["ignore", "pipe", "pipe"]`), the resulting gitlink on the rebased branch equals the commit that was checked out in the submodule, and `.git/rebase-merge` / `.git/rebase-apply` are both absent afterward. This confirms the `git rebase --continue` call in Edit 1 needs no `GIT_EDITOR` workaround.

## Verification

Run from the repository root (`/Users/matkatmusicllc/Programming/taskTools-86`), after making the edits above:

1. `node --test tests/mergeTaskWorktrees.test.ts`
   Expected: all tests pass, including the two named in the brief that must keep passing unchanged (`test_rebaseGroupOntoSourceReportsConflictedPathsAndLeavesNoRebaseInProgress`, `test_rebaseGroupOntoSourceReportsCleanupFailedWhenAbortFails`) and the six new tests added in Edit 4 (`test_rebaseParentOntoSourceAndTestResolvesAnAllowedGitlinkConflictAndReportsRebasedAndTested`, `test_rebaseParentOntoSourceAndTestRebasesThenRunsTheParentsOwnTestCommandAndReportsRebasedAndTested`, `test_rebaseParentOntoSourceAndTestReportsUntestedWhenTheParentHasNoTestConfiguration`, `test_rebaseSubmoduleLayersDeepestFirstRunsTheSubmodulesOwnTestCommandNotTheParents`, `test_rebaseSubmoduleLayersDeepestFirstReportsUntestedWhenTheSubmoduleHasNoTestConfigurationEvenThoughTheParentDoes`, `test_rebaseGroupOntoSourceAbortsAndReportsCleanupFailedWhenStagingAnAllowedConflictFails`). Exit code 0.
2. `npx tsc --noEmit`
   Expected: no type errors (exit code 0) — confirms `ParentRebaseOutcome`, the new `rebaseGroupOntoSource` signature, and the new imports in the test file all typecheck against the existing `RepositoryOccurrence`/`ResolutionManifest`/`ResolutionRequest` types.
