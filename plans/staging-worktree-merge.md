# Merge into a dedicated staging worktree

## Behavior in plain words

The pipeline never changes the branch of the checkout the user works in.
It merges every task branch inside one permanent linked worktree that always sits on the source branch.
Each submodule inside that worktree is itself a linked worktree of the matching submodule in the user's checkout.
So every merge, ref, and object lands in the same git store the user already has. No fetch. No push. No copy.

## Names

| Thing | Identifier |
|---|---|
| The permanent worktree on the source branch | `stagingWorktree` |
| Its path | `stagingWorktreePath(projectRoot)` = `join(resolveTaskWorktreeConventionDirectory(projectRoot), "staging")` |
| Create it, or do nothing when it exists | `ensureStagingWorktree(projectRoot, rootSourceBranch)` |
| Load the source manifest from it | `loadSourceManifest(projectRoot, rootSourceBranch)` |

`listTaskWorktrees` only matches `task-<n>` folders, so the `staging` folder is invisible to task-worktree cleanup. No change there.

## Files

| File | Change |
|---|---|
| `scripts/tackle-tasks/shared/stagingWorktree.ts` | new: `stagingWorktreePath`, `ensureStagingWorktree` |
| `scripts/tackle-tasks/shared/stagingWorktree.test.ts` | new |
| `scripts/tackle-tasks/shared/occurrences.ts` | add `loadSourceManifest`; use it at lines 48, 68, 157, 173 |
| `scripts/tackle-tasks/shared/cleanupTaskWorktree.ts:61` | use `loadSourceManifest` |
| `scripts/mergeTaskWorktrees.ts` | `mergeGroupBranchIntoRepo` and `mergeSubmoduleBranchIntoRepo` stop switching branches; `runMergeCli` merges in the staging worktree |
| `tests/mergeTaskWorktrees.test.ts` | rewrite test at 241, delete test at 263, add dirty-checkout test |
| `scripts/tackle-tasks/shared/mergeTaskWorktree.test.ts` | add dirty-checkout test for the task-157 shape |

## Step 1. `stagingWorktree.ts` (RED then GREEN)

Tests first, in `stagingWorktree.test.ts`. Reuse the fixtures already in `mergeTaskWorktree.test.ts` (`makeSourceRepoWithSubmodule`, `git`). Copy them; do not extract a shared helper.

```ts
test("test_ensureStagingWorktree_addsALinkedWorktreeOnTheSourceBranch", () => {
    // a source repo on main has a staging branch
    // ensureStagingWorktree(repo, "staging")
    // stagingWorktreePath(repo) exists
    // `git -C <path> branch --show-current` is "staging"
    // `git -C <repo> branch --show-current` is still "main"
    // `git -C <repo> worktree list --porcelain` names <path>
});

test("test_ensureStagingWorktree_addsANestedLinkedWorktreePerSubmodule", () => {
    // a source repo with submodule "child"; child checkout is on branch "main"
    // ensureStagingWorktree(repo, "staging")
    // join(<path>, "child", ".git") is a file, not a directory  (a linked worktree marker)
    // `git -C <repo>/child worktree list --porcelain` names join(<path>, "child")
    // `git -C join(<path>, "child") branch --show-current` equals the child's baseBranch from loadRepositoryManifest(repo, "staging")
});

test("test_ensureStagingWorktree_doesNothingWhenTheWorktreeExists", () => {
    // call twice; second call throws nothing and `git worktree list` still names the path once
});

test("test_ensureStagingWorktree_refusesWhenTheWorktreeIsOnAnotherBranch", () => {
    // create it, then `git -C <path> checkout -b wrong`
    // ensureStagingWorktree throws; message names the found branch and the expected branch
});
```

Then the code:

```ts
// One permanent linked worktree on the source branch; merges land here, never in the user's checkout.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRepositoryManifest, resolveTaskWorktreeConventionDirectory } from "../../prepareTasks.ts";

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function stagingWorktreePath(projectRoot: string): string {
    return join(resolveTaskWorktreeConventionDirectory(projectRoot), "staging");
}

function addOrVerifyLinkedWorktree(sourceCheckoutPath: string, worktreePath: string, branch: string): void {
    if (!existsSync(join(worktreePath, ".git"))) {
        git(sourceCheckoutPath, "worktree", "add", worktreePath, branch);
        return;
    }
    const found = git(worktreePath, "branch", "--show-current");
    if (found !== branch) {
        throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"`);
    }
}

// ponytail: `git worktree add` refuses when the user's own checkout already sits on the source branch; git's message is the error.
export function ensureStagingWorktree(projectRoot: string, rootSourceBranch: string): void {
    const rootPath = stagingWorktreePath(projectRoot);
    addOrVerifyLinkedWorktree(projectRoot, rootPath, rootSourceBranch);
    const occurrences = loadRepositoryManifest(projectRoot, rootSourceBranch).occurrences
        .filter((occurrence) => occurrence.occurrenceId !== "")
        .sort((a, b) => a.depth - b.depth);
    for (const occurrence of occurrences) {
        addOrVerifyLinkedWorktree(join(projectRoot, occurrence.occurrenceId), join(rootPath, occurrence.occurrenceId), occurrence.baseBranch);
    }
}
```

Why shallow-first: a nested submodule's folder only exists after its parent worktree exists.
Why `join(rootPath, occurrence.occurrenceId)`: `buildDiscoveryManifest` already joins `occurrenceId` onto a path the same way, so `occurrenceId` is a relative path.
Why `existsSync(join(worktreePath, ".git"))`: after the root `worktree add`, each submodule folder exists but is empty. `git worktree add` accepts an empty folder.

## Step 2. Point every source-checkout path at the staging worktree

In `occurrences.ts` add one function and use it in the four places that call `loadRepositoryManifest(projectRoot, rootSourceBranch)` (lines 48, 68, 157, 173), and in `cleanupTaskWorktree.ts:61`.

```ts
// Every source checkoutPath now lives under the staging worktree; refs are shared, so nothing else moves.
export function loadSourceManifest(projectRoot: string, rootSourceBranch: string): RepositoryManifest {
    ensureStagingWorktree(projectRoot, rootSourceBranch);
    return loadRepositoryManifest(stagingWorktreePath(projectRoot), rootSourceBranch);
}
```

Why load from the staging path and not rewrite paths: discovery reads each checkout's branch and gitlink to fill `baseBranch` and `baseOid`. The staging worktree is now the authority, so read it there.
Why ensure inside the loader: every caller of these loaders already holds the source lock (see the comment at `occurrences.ts:33`), and the merge and rebase entry points both go through them. One choke point, no new pipeline block.

Do not touch `prepareTasks.ts:483`. It runs before the lock and only reads.

## Step 3. Stop switching branches in the two merge functions

`scripts/mergeTaskWorktrees.ts`

`mergeGroupBranchIntoRepo` (429-453): comment out lines 435, 436, 451. Replace line 435-436 with one guard:

```ts
    if (currentBranchName(repoRoot) !== sourceBranch) {
        throw new Error(`merge target "${repoRoot}" is on "${currentBranchName(repoRoot)}", expected "${sourceBranch}"`);
    }
```

`mergeSubmoduleBranchIntoRepo` (472-497): same. Comment out the `foundBranch` read, the `checkout sourceBranch`, and the `checkout foundBranch` at the end. Add the same guard on `mainSubmodulePath`.

Why a guard and not nothing: a merge into the wrong branch is silent data loss. One throw line is the cost.

`runMergeCli` (869-882): add `ensureStagingWorktree(repoRoot, parentSource.sourceBranch)` after `parentSource` is found, then pass `stagingWorktreePath(repoRoot)` instead of `repoRoot` to `mergeGroupBranchIntoRepo`. Keep `removeWorktreeAndBranch(repoRoot, ...)` as is; refs are shared.

## Step 4. Tests in `tests/mergeTaskWorktrees.test.ts`

- Rewrite `test_mergeGroupBranchIntoRepoMergesIntoTheNamedBranchWithoutMovingTheCheckout` (241): drop the `checkout -b some-other-branch` line. Assert the checkout is still on `sourceBranch` after the merge and `sourceBranch:new.txt` holds the content.
- Delete `test_mergeGroupBranchIntoRepoReturnsToTheBranchItFoundAfterMerging` (263). The behavior it pins is gone.
- Add `test_mergeGroupBranchIntoRepoRefusesACheckoutOnAnotherBranch`: check out `some-other-branch`, call, expect a throw whose message names both branches.
- Add `test_mergeSubmoduleBranchIntoRepoRefusesASubmoduleCheckoutOnAnotherBranch`: same shape on `repoRoot/vendor`.

## Step 5. The task-157 acceptance test

In `scripts/tackle-tasks/shared/mergeTaskWorktree.test.ts`, next to the test that ends at line 241:

```ts
test("test_mergeTaskWorktree_mergesWhileTheProjectRootHasUncommittedEdits", async () => {
    // same setup as the test above: rootOrigin on main, staging present, a rebased task worktree
    // write an unrelated uncommitted file into rootOrigin: writeFileSync(join(rootOrigin, "scratch.txt"), "wip\n")
    // mergeTaskWorktree(...) returns merged: true
    // rootOrigin is still on "main"
    // scratch.txt still exists in rootOrigin, untracked, content "wip"
    // `git -C rootOrigin rev-parse staging` equals the root merge commit hash
    // the submodule merge commit is reachable from rootOrigin/child: `git -C rootOrigin/child cat-file -t <childHash>` is "commit"
});
```

Why the last line: it proves the nested linked worktree shares the submodule's object store, which is the whole reason for the nested-worktree design.

This test is RED before Step 2 because `verifySourceTipsUnchangedSinceRebase` still reads `projectRoot` and refuses the dirty tree. After Step 2 it reads the staging worktree, which is clean.

## Step 6. Order of work

1. Step 1 tests RED, then Step 1 code GREEN.
2. Step 5 test RED.
3. Step 2 edits. Step 5 GREEN.
4. Step 3 edits and Step 4 tests.
5. Full suite via the loop in `~/.claude/CLAUDE.md` "Full Suite Testing". Expect fixture-driven failures where a test builds a manifest by hand with `checkoutPath` under `repoRoot` and then calls `mergeTaskDeepestFirst` directly (`tests/mergeTaskWorktrees.test.ts` around 1468, 1584, 1676). Those call the merge functions with a checkout already on `sourceBranch`, so they should stay green. If one goes red, the fix is in the fixture's branch setup, never in the merge code.

## Skipped

- No new pipeline block or `.mmd` change. The loader creates the worktree.
- No fetch-back into the user's submodule checkouts. Nested linked worktrees share refs and objects, so there is nothing to copy.
- No new lock. The source lock already covers every caller.
- Known ceiling: a user whose own checkout sits on `staging` gets git's "already checked out" error at `worktree add`. Add a detach-or-explain path only when someone hits it.
