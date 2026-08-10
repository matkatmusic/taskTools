# Task 175 plan: delete the task branch at every repository layer after a successful close

## Problem (confirmed by reading the owned files)

`mergeTaskDeepestFirst` in `scripts/mergeTaskWorktrees.ts` is the merge path the live
workflow (`skills/tackle-tasks/task.workflow.js`, `runMerge`) actually calls. For every
submodule occurrence it either:

- takes the "no-op" branch (lines 550-554) when the occurrence's operation branch is
  already fully contained in its base branch, after having fetched that operation
  branch into the source checkout unconditionally at lines 533-541, or
- takes the "merged" branch (lines 574-581) by calling
  `mergeStepOperations.mergeSubmodule` (`mergeSubmoduleBranchIntoRepo`, lines 423-441),
  which itself does `git(mainSubmodulePath, "fetch", worktreeSubmodulePath,
  "${groupBranch}:refs/heads/${groupBranch}")` (line 429) — creating
  `refs/heads/<groupBranch>` in the submodule's source checkout.

Neither branch ever deletes that ref afterward. `task.workflow.js`'s `runMerge` (lines
678-724) calls `removeWorktreeAndBranch` exactly once, at line 718, for the root
worktree/branch only:

```js
removeWorktreeAndBranch(mainRepoRoot, repoRoot, branch)
```

`removeWorktreeAndBranch` (`scripts/mergeTaskWorktrees.ts` lines 443-446) only ever
touches the one `repoRoot`/`worktreePath`/`branchName` triple it is given — it has no
way to reach a submodule's source checkout, and nothing calls it for a submodule.
Every successful merge run leaves one `refs/heads/task-N` ref behind in every
submodule's source checkout.

The fix belongs inside `mergeTaskDeepestFirst` itself: it already walks every
occurrence deepest-first and already holds `sourceCheckoutPath` and
`occurrence.operationBranch` for each one, at the exact point where that submodule's
branch has just been fetched and consumed (no-op) or merged (merged). No information
needs to travel anywhere else, and `task.workflow.js` needs no change — its existing
single `removeWorktreeAndBranch` call for the root is already correct and stays as is.

Root itself must be excluded from this new deletion: root's `operationBranch` is the
worktree's own branch (created by `git worktree add`, sharing the same repo/ref store
as `repoRoot`), which `task.workflow.js`'s `removeWorktreeAndBranch(mainRepoRoot,
repoRoot, branch)` call still owns deleting, after the whole merge succeeds. Root is
identified in the loop by `occurrence.parentOccurrenceId === null`; every submodule
occurrence has `occurrence.parentOccurrenceId !== null`.

## Edits

### `scripts/mergeTaskWorktrees.ts`

**Edit 1 — no-op branch, lines 550-554.**

Current text:
```
        if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "no-op", oid });
            continue;
        }
```

Becomes:
```
        if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "no-op", oid });
            if (occurrence.parentOccurrenceId !== null) git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
            continue;
        }
```

This is reached both for a genuinely already-merged submodule and for root itself
(when root's own operation branch turns out to already be fully contained in its base
branch). The `parentOccurrenceId !== null` guard keeps this deletion scoped to
submodule layers only, leaving root's branch for `task.workflow.js`'s existing
`removeWorktreeAndBranch` call to delete.

**Edit 2 — merged-submodule branch, lines 574-581.**

Current text:
```
            const result = mergeStepOperations.mergeSubmodule(sourceCheckoutPath, occurrence.checkoutPath, occurrence.baseBranch);
            if (!result.merged) {
                return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: result.conflictedFilePaths, failureReason: result.failureReason };
            }
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
            continue;
```

Becomes:
```
            const result = mergeStepOperations.mergeSubmodule(sourceCheckoutPath, occurrence.checkoutPath, occurrence.baseBranch);
            if (!result.merged) {
                return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: result.conflictedFilePaths, failureReason: result.failureReason };
            }
            git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
            continue;
```

This branch is only ever entered when `occurrence.parentOccurrenceId !== null` (it sits
inside the enclosing `if (occurrence.parentOccurrenceId !== null) { ... }` block that
starts at line 559), so no extra guard is needed here — every occurrence that reaches
this line is a submodule, never root. `occurrence.operationBranch` is the same branch
name `mergeStepOperations.mergeSubmodule`'s default implementation
(`mergeSubmoduleBranchIntoRepo`) just fetched into `sourceCheckoutPath` as
`currentBranchName(worktreeSubmodulePath)` — every occurrence built by
`attachOperationBranch` (used by the real workflow) and every occurrence built by the
test file's own `makeOccurrence`/`buildMergePrimitiveFixture` helpers keeps
`operationBranch` equal to the worktree submodule's actual checked-out branch name, so
deleting `occurrence.operationBranch` here targets the exact ref that was just merged.
`git branch -D` deletes regardless of merge status, so the just-merged branch (now an
ancestor of `baseBranch`) deletes cleanly.

No other spot in `scripts/mergeTaskWorktrees.ts` needs an edit: `removeWorktreeAndBranch`
(lines 443-446), `mergeGroupBranchIntoRepo` (lines 387-404), and
`mergeSubmoduleBranchIntoRepo` (lines 423-441) all stay as they are — the two edits
above are the only places that both know the submodule's `sourceCheckoutPath` and
`operationBranch` and are guaranteed to run exactly once per submodule occurrence,
after that occurrence's branch has done its job.

### `skills/tackle-tasks/task.workflow.js`

No edit. `runMerge`'s single call to `removeWorktreeAndBranch(mainRepoRoot, repoRoot,
branch)` at line 718 is already correct for the root worktree and root branch — the
root is the one layer that keeps a worktree, and this call is the one place that must
delete it. The submodule leak this task fixes never involved this file: every fetched
submodule ref is created and consumed entirely inside
`mergeTaskDeepestFirst` (in `scripts/mergeTaskWorktrees.ts`), which is exactly where
Edits 1 and 2 above delete it. Reaching into `task.workflow.js` to pass submodule
branch/path information out to a second cleanup call would duplicate information
`mergeTaskDeepestFirst` already has in scope, which the brief itself rules out
("that layer information needs to reach the cleanup step -- or cleanup must
re-derive the submodule paths and branch names" — the plan takes the second option,
inside the function that already knows them, instead of the first).

### `tests/mergeTaskWorktrees.test.ts`

**Edit 3 — rewrite the false-positive test, lines 1508-1531.**

Current text:
```
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
```

Becomes:
```
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

    // mergeTaskDeepestFirst must have already deleted the fetched submodule task branch itself.
    const submoduleBranches = git(fixture.mainSubmodulePath, "branch", "--list", submoduleTaskBranch);
    assert.equal(submoduleBranches.includes(submoduleTaskBranch), false);

    removeWorktreeAndBranch(fixture.rootPath, fixture.group.worktree, fixture.group.branch);

    assert.doesNotThrow(() => git(fixture.rootPath, "rev-parse", fixture.sourceBranch));
    assert.doesNotThrow(() => git(fixture.mainSubmodulePath, "merge-base", "--is-ancestor", rootGitlinkOid, fixture.submoduleSourceBranch));
});
```

The only change is removing the manual `git(fixture.mainSubmodulePath, "branch", "-D",
submoduleTaskBranch)` call (the false positive named in the brief — it supplied the
very production behavior the test should assert) and replacing it with an assertion
that `mergeTaskDeepestFirst` already deleted that branch on its own, via `git branch
--list`. `removeWorktreeAndBranch(fixture.rootPath, fixture.group.worktree,
fixture.group.branch)` for the root worktree/branch stays: that deletion is still a
separate, genuine caller responsibility (mirroring what `task.workflow.js`'s `runMerge`
does for real), not something `mergeTaskDeepestFirst` performs itself.

No other test in this file needs a change:
- Every other caller of `mergeStepOperations.mergeSubmodule` that reaches the merged
  branch either delegates to the real `mergeSubmoduleBranchIntoRepo` (so the branch
  exists to delete) or returns `merged: false` (so deletion is never reached, guarded
  by the existing `if (!result.merged) return` check).
- Every occurrence that reaches the no-op branch inside a test either already has its
  branch fetched (by the pre-loop fetch at lines 533-541, or by the test's own manual
  pre-merge in `test_mergeTaskDeepestFirstSkipsAnOccurrenceAlreadyMergedIntoItsSourceWithoutInvokingItsRebaseOrMergeStep`),
  so the delete never targets a nonexistent ref, or is root, which the new
  `parentOccurrenceId !== null` guard skips.
- No test asserts that a submodule's fetched branch still exists after a successful
  `mergeTaskDeepestFirst` call other than the one rewritten above.
- Tests checking `git status --short` / `write-tree` cleanliness in the submodule's
  source checkout (`test_mergeTaskDeepestFirstLeavesTheSourceCheckoutsIndexAndWorkingTreeAtTheMergedCommit`)
  are unaffected: deleting a branch ref that is not the currently checked-out branch
  never touches the working tree or index.

## Verification

Run the whole owned test file:

```
node --test tests/mergeTaskWorktrees.test.ts
```

Expected: all tests pass, including the rewritten
`test_mergeTaskDeepestFirstLeavesNoDanglingGitlinkAfterEveryTaskBranchIsDeleted`, which
now fails if Edits 1/2 are missing (the submodule branch would still exist and
`submoduleBranches.includes(submoduleTaskBranch)` would be `true`), and passes once
they are in place.

Then run the full suite per repo convention (node's test runner, not bun):

```
npm test
```

Expected: exit code 0, no new failures introduced anywhere else in the suite.

The rewritten test in Edit 3 already exercises the fix end-to-end (it fetches a
submodule branch into the source checkout via `mergeTaskDeepestFirst`, then asserts
that branch is gone), so no separate manual repro script is needed.
