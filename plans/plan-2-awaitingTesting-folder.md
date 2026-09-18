# PLAN 2 — the `awaitingTesting` folder

Needs: nothing. Order of work: Plan 2, then Plan 1, then Plan 3.

## Rules for every plan
- Test first: write the failing test, run ONLY that test file with `node --test <file>` to see it fail for the stated reason, then write the code.
- The FULL suite runs only through `npm run test:baseline`. Edit agents never run the full suite. One later agent owns that run.
- Never commit. Never delete retired code; comment it out.
- No helper extraction, no refactor. Two near-identical blocks of code stay two blocks.
- One condition for each `if`; nest, do not chain with `&&`.
- A comment is one line, under 20 words. Never two stacked `//` lines.

## Context

Problem: the pipeline keeps ONE shared checkout folder for the `staging` branch. Two things are wrong with it. (1) The folder is named `staging`, the same word as the branch, so people and code mix the two up. (2) The merge tool (`--merge`) can put that folder on the USER'S branch. When the user then commits on that branch, the folder looks dirty to the guard, and EVERY pipeline run throws (task 29). Goal: the folder is named `awaitingTesting`; it is always on the branch `staging`; a folder left in the broken state repairs itself when it holds no work.

Word use: `staging` is a BRANCH. The shared checkout folder `<tmp>/taskTools-wt/<repo>-<hash>/staging` shared its name with the branch. The folder gets the name `awaitingTesting`. The branch name never changes.

The proven failure (task 29 in `~/Programming/relationship-mermaid`, run `2026-09-17T01-44-36-83560`):

```
Error: staging worktree at ".../relationship-mermaid-dd53a9ae/staging" is on "develop", expected "staging"
  at scripts/tackle-tasks/shared/stagingWorktree.ts:34
```

Cause: the folder was made on 2026-09-14 on the user's own branch `develop` (a second checkout, allowed by `--force`). The user then committed on `develop`. The folder's index fell behind its HEAD, so `git status --porcelain` shows 37 staged files. Those files are exactly the tree of old commit `ff97b51`. No work is in the folder. The guard at `stagingWorktree.ts:31-34` rebuilds a wrong-branch folder only when `status --porcelain` is empty. That can never be true after the user commits. So it throws on every run.

Read-only proof on the real folder (run with `GIT_OPTIONAL_LOCKS=0`):

| Command | Result |
|---|---|
| `git -C <folder> branch --show-current` | `develop` |
| `git -C <folder> diff --quiet` | exit 0 |
| `git -C <folder> ls-files --others --exclude-standard` | no lines |
| `git -C <folder> status --porcelain` | 37 lines |

One tool still puts the folder on the user's branch: `scripts/merge-worktree-tasks/mergeTaskWorktrees.ts:888` and `:895` pass `parentSource.sourceBranch`, which is the current branch of the main checkout (`scripts/shared/repositoryBranches.ts:55,68-70`). `mergeGroupBranchIntoRepo` uses that value only for the guard `currentBranchName(repoRoot) !== sourceBranch` (`mergeTaskWorktrees.ts:430-440`). `MERGE_WORKTREES.ts:17-20` already passes `"staging"`.

## The rule for a leftover folder

A leftover folder holds work only when one of these is true:
1. `git -C <folder> diff --quiet` exits non-zero (working files differ from the folder's OWN index).
2. `git -C <folder> ls-files --others --exclude-standard` prints a line (untracked files).

Holds work: throw, with the reason line, then the output of `git -C <folder> status --porcelain`.
Holds no work: `git -C <sourceCheckoutPath> worktree remove --force <folder>`, then `git -C <sourceCheckoutPath> worktree prune`.

Two leftover cases use this rule. The code for the rule is written out in each place. It is not a shared function.

## Files

- `scripts/tackle-tasks/shared/stagingWorktree.ts`
- `scripts/tackle-tasks/shared/stagingWorktree.test.ts`
- `tests/stagingWorktreeStale.test.ts`
- `scripts/merge-worktree-tasks/mergeTaskWorktrees.ts`
- `tests/mergeTaskWorktrees.test.ts`
- `scripts/merge-worktree-tasks/mergeWorktreeTasksBrief.ts`
- `tests/mergeWorktreeTasksBrief.test.ts`

No test hard-codes the folder name as a path part. All use `stagingWorktreePath()`. Line 53's `"staging"` in `stagingWorktree.ts` is a branch name and stays.

## Steps

### Step 1 — RED: the folder name
File: `scripts/tackle-tasks/shared/stagingWorktree.test.ts`. Add `basename` to the `node:path` import.

```ts
test("test_stagingWorktreePath_endsInAwaitingTesting", () => {
    // Scenario: the shared checkout folder is named awaitingTesting, never the branch name.
    // Setup: a repo with one commit.
    const repo = makeTempRepoWithTestScript("main");
    // Test action: ask for the shared checkout folder path.
    const path = stagingWorktreePath(repo);
    // Test verification: the last path segment is awaitingTesting.
    assert.equal(basename(path), "awaitingTesting");
});
```
Expected RED: actual is `"staging"`.

### Step 2 — GREEN: the folder name
File: `stagingWorktree.ts:12`.

```ts
    // return join(resolveTaskWorktreeConventionDirectory(projectRoot), "staging");
    return join(resolveTaskWorktreeConventionDirectory(projectRoot), "awaitingTesting");
```

### Step 3 — RED: `awaitingTesting` is on the user's branch, and that branch moved
This fixture can show the real failure: it puts the folder on the user's branch, then commits on that branch in the source checkout.
File: `tests/stagingWorktreeStale.test.ts`. Add `makeCommittedRepo` to the gitFixtures import; `existsSync`, `realpathSync` to `node:fs`; `dirname` to `node:path`.

```ts
test("test_ensureStagingWorktree_rebuildsAwaitingTestingLeftOnTheUsersBranchAfterThatBranchMoved", () => {
    // Scenario: the folder double-checks-out the user's branch, then the user commits on that branch.
    // Setup: a repo on main with a staging branch and a built awaitingTesting folder.
    const repo = makeCommittedRepo("awaiting-testing-", "main");
    git(repo, "branch", "staging");
    ensureStagingWorktree(repo, "staging");
    const awaitingTestingPath = stagingWorktreePath(repo);
    // Setup: put the folder on main, the way the retired --force contract did.
    git(awaitingTestingPath, "checkout", "-q", "--ignore-other-worktrees", "main");
    // Setup: the user commits on main in their own checkout, so the folder's index falls behind its HEAD.
    writeFileSync(join(repo, "users-work.txt"), "work\n");
    git(repo, "add", "users-work.txt");
    git(repo, "commit", "-q", "-m", "user commit on main");
    // Fixture proof: the folder now shows staged files, exactly like the real broken folder.
    assert.notEqual(git(awaitingTestingPath, "status", "--porcelain"), "");
    // Test action: the normal launch path runs.
    assert.doesNotThrow(() => ensureStagingWorktree(repo, "staging"));
    // Test verification: the folder was rebuilt on staging.
    assert.equal(git(awaitingTestingPath, "branch", "--show-current"), "staging");
});
```
Expected RED: throws `is on "main", expected "staging"` from line 34.

### Step 4 — RED: staged-only drift is not real work, in `addOrVerifyLinkedWorktree`
File: `tests/stagingWorktreeStale.test.ts`.

```ts
test("test_ensureStagingWorktree_refusesWhenAnEditIsStagedOnly", () => {
    // Scenario: the folder is on a different branch, and the only drift from its own index is staged.
    // Setup: a repo on main with a staging branch and a built awaitingTesting folder.
    const repo = makeCommittedRepo("staged-only-", "main");
    git(repo, "branch", "staging");
    ensureStagingWorktree(repo, "staging");
    const awaitingTestingPath = stagingWorktreePath(repo);
    // Setup: put the folder on a branch other than staging.
    git(awaitingTestingPath, "checkout", "-q", "-B", "oldbase");
    // Setup: edit the tracked file and stage it, but do not commit.
    writeFileSync(join(awaitingTestingPath, "seed.txt"), "edited\n");
    git(awaitingTestingPath, "add", "seed.txt");
    // Test action and verification: the folder holds staged work, so it refuses.
    assert.throws(
        () => ensureStagingWorktree(repo, "staging"),
        (error: Error) => error.message.includes('is on "oldbase"'),
    );
});
```
Expected RED: does not throw; the folder is rebuilt and the staged edit is lost.

```ts
test("test_ensureStagingWorktree_refusesWhenAMergeIsStoppedBeforeItsCommit", () => {
    // Scenario: the folder is on a different branch, mid a clean merge that never got its commit.
    // Setup: a repo on main with a staging branch and a built awaitingTesting folder.
    const repo = makeCommittedRepo("merge-stopped-", "main");
    git(repo, "branch", "staging");
    ensureStagingWorktree(repo, "staging");
    const awaitingTestingPath = stagingWorktreePath(repo);
    // Setup: a branch with one new file, to merge cleanly with --no-commit.
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-q", "-m", "feature work");
    git(repo, "checkout", "-q", "main");
    // Setup: put the folder on a branch other than staging.
    git(awaitingTestingPath, "checkout", "-q", "-B", "oldbase");
    // Setup: a clean merge, stopped before its commit.
    git(awaitingTestingPath, "merge", "--no-commit", "--no-ff", "feature");
    // Test action and verification: the folder holds staged work, so it refuses.
    assert.throws(
        () => ensureStagingWorktree(repo, "staging"),
        (error: Error) => error.message.includes('is on "oldbase"'),
    );
});
```
Expected RED: does not throw; the folder is rebuilt and the merge's staged content is lost.

### Step 5 — GREEN: the rule, inside `addOrVerifyLinkedWorktree`
File: `stagingWorktree.ts`, the `if (found !== branch && found !== "")` block in `addOrVerifyLinkedWorktree` (today lines 31-40; Step 2 adds one line above it, so after Step 2 this block sits at lines 32-41). That existing `if` stays as it is. Comment out the old check and the `rmSync`. Write the rule inline, with a third check: the index may equal the working tree and hold no untracked file, and still hold staged-only work.

```ts
    if (found !== branch && found !== "") {
        // const status = git(worktreePath, "status", "--porcelain");
        // if (status !== "") {
        //     throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"\n${status}`);
        // }
        // Work is files that differ from the folder's own index, or untracked files, or a staged tree with no matching commit.
        const diffAgainstOwnIndex = spawnSync("git", ["-C", worktreePath, "diff", "--quiet"], { encoding: "utf8" });
        if (diffAgainstOwnIndex.status !== 0) {
            throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"\n${git(worktreePath, "status", "--porcelain")}`);
        }
        const untrackedFiles = git(worktreePath, "ls-files", "--others", "--exclude-standard");
        if (untrackedFiles !== "") {
            throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"\n${git(worktreePath, "status", "--porcelain")}`);
        }
        const treeOfWrittenIndex = git(worktreePath, "write-tree");
        const treesInHistory = git(worktreePath, "log", "--format=%T", "HEAD").split("\n");
        if (!treesInHistory.includes(treeOfWrittenIndex)) {
            throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"\n${git(worktreePath, "status", "--porcelain")}`);
        }
        git(sourceCheckoutPath, "worktree", "remove", "--force", worktreePath);
        git(sourceCheckoutPath, "worktree", "prune");
        // rmSync(worktreePath, { recursive: true, force: true });
        git(sourceCheckoutPath, "worktree", "add", "--quiet", "--force", worktreePath, branch);
        return;
    }
```
The message shape does not change. The existing test `...RebuildsAStaleSubmoduleWorktreeWhenClean_ButRefusesWhenDirty` uses an untracked `dirty.txt`, so it still throws. In Step 3 the folder's index holds the tree of the commit `main` had before the user's commit. That commit is an ancestor of the folder's HEAD, so its tree IS a line of `log --format=%T HEAD`; the third check does not fire, and the folder is still rebuilt.

### Step 6 — RED: an old `staging` folder on the user's branch is removed
File: `tests/stagingWorktreeStale.test.ts`.

```ts
test("test_ensureStagingWorktree_removesARetiredStagingFolderLeftOnTheUsersBranch", () => {
    // Scenario: a machine still has the old ".../staging" folder, on the user's branch, with staged drift.
    // Setup: a repo on main with a staging branch.
    const repo = makeCommittedRepo("retired-staging-", "main");
    git(repo, "branch", "staging");
    // Setup: the retired folder, checked out on main a second time.
    const retiredStagingFolderPath = join(dirname(stagingWorktreePath(repo)), "staging");
    git(repo, "worktree", "add", "--quiet", "--force", retiredStagingFolderPath, "main");
    const retiredStagingFolderRealPath = realpathSync(retiredStagingFolderPath);
    // Setup: the user commits on main, so the retired folder shows staged files.
    writeFileSync(join(repo, "users-work.txt"), "work\n");
    git(repo, "add", "users-work.txt");
    git(repo, "commit", "-q", "-m", "user commit on main");
    // Fixture proof: staged drift exists.
    assert.notEqual(git(retiredStagingFolderPath, "status", "--porcelain"), "");
    // Test action: the normal launch path runs.
    ensureStagingWorktree(repo, "staging");
    // Test verification: the retired folder is gone from disk and from git's worktree list.
    assert.equal(existsSync(retiredStagingFolderPath), false);
    assert.equal(git(repo, "worktree", "list", "--porcelain").includes(retiredStagingFolderRealPath), false);
});
```
Expected RED: the retired folder still exists.

### Step 7 — RED: an old `staging` folder that holds work refuses (two tests)

```ts
test("test_ensureStagingWorktree_refusesToRemoveARetiredStagingFolderWithUntrackedFiles", () => {
    // Setup: a repo on main, a staging branch, and the retired folder on main.
    const repo = makeCommittedRepo("retired-staging-", "main");
    git(repo, "branch", "staging");
    const retiredStagingFolderPath = join(dirname(stagingWorktreePath(repo)), "staging");
    git(repo, "worktree", "add", "--quiet", "--force", retiredStagingFolderPath, "main");
    // Setup: an untracked file in the retired folder.
    writeFileSync(join(retiredStagingFolderPath, "scratch.txt"), "scratch\n");
    // Test action and verification: a loud error naming the folder and the file.
    assert.throws(
        () => ensureStagingWorktree(repo, "staging"),
        (error: Error) => error.message.includes("retired staging folder") && error.message.includes("scratch.txt"),
    );
    // Test verification: the folder was not removed.
    assert.equal(existsSync(join(retiredStagingFolderPath, "scratch.txt")), true);
});
```
Second test: `test_ensureStagingWorktree_refusesToRemoveARetiredStagingFolderWithUnstagedEdits`. Same body, two differences: the setup line is `writeFileSync(join(retiredStagingFolderPath, "seed.txt"), "edited\n");`, and the message check uses `"seed.txt"`; the last assert is `existsSync(retiredStagingFolderPath) === true`.

### Step 8 — RED: a retired `staging` folder already on `staging` is removed too
File: `tests/stagingWorktreeStale.test.ts`.

```ts
test("test_ensureStagingWorktree_removesARetiredStagingFolderLeftOnTheStagingBranch", () => {
    // Scenario: a machine still has the old ".../staging" folder, already checked out on staging, clean.
    // Setup: a repo on main with a staging branch.
    const repo = makeCommittedRepo("retired-staging-on-staging-", "main");
    git(repo, "branch", "staging");
    // Setup: the retired folder, checked out on staging.
    const retiredStagingFolderPath = join(dirname(stagingWorktreePath(repo)), "staging");
    git(repo, "worktree", "add", "--quiet", "--force", retiredStagingFolderPath, "staging");
    // Test action: the normal launch path runs.
    ensureStagingWorktree(repo, "staging");
    // Test verification: the retired folder is gone.
    assert.equal(existsSync(retiredStagingFolderPath), false);
    // Test verification: the shared folder is on staging.
    assert.equal(git(stagingWorktreePath(repo), "branch", "--show-current"), "staging");
});
```
Expected RED: the retired folder still exists.

### Step 9 — RED: a retired `staging` folder that holds staged-only work refuses (two tests)
File: `tests/stagingWorktreeStale.test.ts`.

```ts
test("test_ensureStagingWorktree_refusesToRemoveARetiredStagingFolderWhenAnEditIsStagedOnly", () => {
    // Setup: a repo on main, a staging branch, and the retired folder on main.
    const repo = makeCommittedRepo("retired-staging-", "main");
    git(repo, "branch", "staging");
    const retiredStagingFolderPath = join(dirname(stagingWorktreePath(repo)), "staging");
    git(repo, "worktree", "add", "--quiet", "--force", retiredStagingFolderPath, "main");
    // Setup: edit the tracked file and stage it, but do not commit.
    writeFileSync(join(retiredStagingFolderPath, "seed.txt"), "edited\n");
    git(retiredStagingFolderPath, "add", "seed.txt");
    // Test action and verification: a loud error naming the folder.
    assert.throws(
        () => ensureStagingWorktree(repo, "staging"),
        (error: Error) => error.message.includes("retired staging folder"),
    );
    // Test verification: the folder was not removed.
    assert.equal(existsSync(retiredStagingFolderPath), true);
});
```

```ts
test("test_ensureStagingWorktree_refusesToRemoveARetiredStagingFolderWhenAMergeIsStoppedBeforeItsCommit", () => {
    // Setup: a repo on main, a staging branch, and the retired folder on main.
    const repo = makeCommittedRepo("retired-staging-", "main");
    git(repo, "branch", "staging");
    const retiredStagingFolderPath = join(dirname(stagingWorktreePath(repo)), "staging");
    git(repo, "worktree", "add", "--quiet", "--force", retiredStagingFolderPath, "main");
    // Setup: a branch with one new file, to merge cleanly with --no-commit.
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-q", "-m", "feature work");
    git(repo, "checkout", "-q", "main");
    // Setup: a clean merge in the retired folder, stopped before its commit.
    git(retiredStagingFolderPath, "merge", "--no-commit", "--no-ff", "feature");
    // Test action and verification: a loud error naming the folder.
    assert.throws(
        () => ensureStagingWorktree(repo, "staging"),
        (error: Error) => error.message.includes("retired staging folder"),
    );
    // Test verification: the folder was not removed.
    assert.equal(existsSync(retiredStagingFolderPath), true);
});
```

### Step 10 — GREEN: remove the old `staging` folder on the launch path
File: `stagingWorktree.ts`. These are the FIRST statements of `ensureStagingWorktree`, before `const rootPath`. They must run before `resolveOrCreateStagingTipEverywhere`, because `git branch -f staging` names the checkout that holds `staging` (`scripts/shared/prepareTasks.ts:217-226`) and fast-forwards there. No existing line moves. The rule is written inline a second time, with the same third check as Step 5.

```ts
    // The folder was named "staging" until the rename; one left behind still holds the branch.
    const retiredStagingFolderPath = join(resolveTaskWorktreeConventionDirectory(projectRoot), "staging");
    if (existsSync(retiredStagingFolderPath)) {
        if (isLiveWorktree(retiredStagingFolderPath, projectRoot)) {
            const diffAgainstOwnIndex = spawnSync("git", ["-C", retiredStagingFolderPath, "diff", "--quiet"], { encoding: "utf8" });
            if (diffAgainstOwnIndex.status !== 0) {
                throw new Error(`retired staging folder at "${retiredStagingFolderPath}" must be removed but holds work\n${git(retiredStagingFolderPath, "status", "--porcelain")}`);
            }
            const untrackedFiles = git(retiredStagingFolderPath, "ls-files", "--others", "--exclude-standard");
            if (untrackedFiles !== "") {
                throw new Error(`retired staging folder at "${retiredStagingFolderPath}" must be removed but holds work\n${git(retiredStagingFolderPath, "status", "--porcelain")}`);
            }
            const treeOfWrittenIndex = git(retiredStagingFolderPath, "write-tree");
            const treesInHistory = git(retiredStagingFolderPath, "log", "--format=%T", "HEAD").split("\n");
            if (!treesInHistory.includes(treeOfWrittenIndex)) {
                throw new Error(`retired staging folder at "${retiredStagingFolderPath}" must be removed but holds work\n${git(retiredStagingFolderPath, "status", "--porcelain")}`);
            }
            git(projectRoot, "worktree", "remove", "--force", retiredStagingFolderPath);
            git(projectRoot, "worktree", "prune");
        }
    }
```
`isLiveWorktree` proves, right before the removal, that the folder belongs to this repository. `loadSourceManifest` (`occurrences.ts:54`) calls `ensureStagingWorktree` from nearly every pipeline block, so this throw can show in the middle of a run; after one good removal the `existsSync` check above is false and the code does nothing.

### Step 11 — GREEN: the stale comment
File: `stagingWorktree.ts`, the `// --force: ...` comment line directly above `function addOrVerifyLinkedWorktree` (line 22 today; Step 2 moves it down one line). Replace that one comment line:

```ts
// --force: re-adds a path git still has registered; the branch is "staging", never the user's branch.
```

### Step 12 — RED: the merge tool puts the folder on `staging`
File: `tests/mergeTaskWorktrees.test.ts`. Import `stagingWorktreePath`. This file's `git()` does not trim. No existing test runs the `--merge` mode.

```ts
test("test_mergeCli_checksOutTheStagingBranchInTheSharedFolderNotTheUsersBranch", () => {
    // Setup: a repo on the user's branch, with a task worktree holding one commit.
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 9301);
    writeFileSync(join(group.worktree, "task-work.txt"), "task work\n");
    git(group.worktree, "add", "task-work.txt");
    git(group.worktree, "commit", "-q", "-m", "task work");
    // Test action: run the --merge CLI from the repo root.
    execFileSync("node", ["--no-inspect", SCRIPT, "--merge", group.worktree], { cwd: repoRoot, encoding: "utf8" });
    // Test verification: the shared folder sits on staging, not on the user's branch.
    assert.equal(git(stagingWorktreePath(repoRoot), "branch", "--show-current").trim(), "staging");
});
```
Expected RED: actual is the repository's default branch name. Confirm the failure is that assertion, not a fixture crash.

### Step 13 — GREEN: the merge tool
File: `mergeTaskWorktrees.ts`, function `runMergeCli`. Lines 885-887 stay (`collectRepositorySources` still feeds `submodulePathsDeepestFirst`).

```ts
    // ensureStagingWorktree(repoRoot, parentSource.sourceBranch);
    ensureStagingWorktree(repoRoot, "staging");
```
```ts
    // const outcome = mergeGroupBranchIntoRepo(stagingWorktreePath(repoRoot), group, parentSource.sourceBranch, submodulePathsDeepestFirst);
    const outcome = mergeGroupBranchIntoRepo(stagingWorktreePath(repoRoot), group, "staging", submodulePathsDeepestFirst);
```

### Step 14 — RED: the brief says where the merged work landed
File: `tests/mergeWorktreeTasksBrief.test.ts`. `brief` is already imported.

```ts
test("brief says the merged work is on staging in the awaitingTesting folder", () => {
    assert.ok(brief.includes("is now on the `staging` branch, in the `awaitingTesting` folder"));
    assert.doesNotMatch(brief, /the branch you were on when you ran/);
});
```
Expected RED: the actual sentence is "the branch you were on when you ran `--discover`."

### Step 15 — GREEN: the brief sentence
File: `scripts/merge-worktree-tasks/mergeWorktreeTasksBrief.ts:45-46`. `brief` is a template literal, so the old sentence cannot be commented out without changing the printed text; replace it.

```ts
and, if it had matched task numbers, note that those tasks' work is now on
the \`staging\` branch, in the \`awaitingTesting\` folder. If \`merged: false\`, report
```
The byte-for-byte test in Step 14's file compares `brief` against the pinned pre-refactor commit's text. Add one more `.replace()` call there, next to the existing ones, so that pinned historical sentence still maps onto the new wording:

```ts
.replace(
    "the branch you were on when you ran `--discover`.",
    "the `staging` branch, in the `awaitingTesting` folder.",
)
```

## Verification

1. `npm run test:baseline`: 12 new tests pass (Step 1: 1, Step 3: 1, Step 4: 2, Step 6: 1, Step 7: 2, Step 8: 1, Step 9: 2, Step 12: 1, Step 14: 1); the existing stale-submodule test still passes; no new failure.
2. `rg -n '"staging"\)' scripts/tackle-tasks/shared/stagingWorktree.ts` shows 3 lines: the commented-out old return (Step 2), the new retired-folder line (Step 10), and the existing submodule branch line (`addOrVerifyLinkedWorktree(join(projectRoot, occurrence.occurrenceId), submoduleWorktreePath, "staging");`).
3. After the next real run in `~/Programming/relationship-mermaid`: `git -C ~/Programming/relationship-mermaid worktree list` shows `.../awaitingTesting [staging]` and no `.../staging` line. Paste the command and its output.

Not in this plan: `resetTask.ts:199-205`, the error-text search in `moveStagingBranchTo`, the order of lines inside `ensureStagingWorktree`, leaked test folders under `taskTools-wt`. No run has shown a failure from them.

