# Plan: every task worktree starts from the tip of `staging`

## Background: why tasks 192 and 160 took days

Tasks 192 and 160 block every other open entry in tasks.json. Their runs failed one step at a time, over multiple days, for these reasons:

- **The merge target changed, but many steps still asked git for the current branch.** On August 29 the merge target became the fixed branch `staging`. Before that, runs launched from a checkout that sat on the target branch, so "current branch" and "target branch" were the same name. After that, every step that still read the current branch of the launching checkout got the wrong branch. Seven steps were fixed on August 29. Three more failed and were fixed on September 2: the commit step, the test step, and the conflict step. Each fix let the run get one step further before the next one failed.
- **The merge ran inside the user's own checkout.** The old merge swapped branches in the launching checkout. Task 192's uncommitted files there blocked task 157's merge on September 1. The merge now lands in its own staging worktree.
- **Codex died mid-review.** Task 192's plan reviews on August 31 crashed inside the codex tool three times. This was worked around with relaunches. The cause is outside this repo and can return.
- **Codex never started for task 160.** The detached launch used `setsid`, which macOS lacks, and a heredoc with an apostrophe that macOS `sh` cannot parse inside `$(...)`. Both were fixed on September 2, together with a poll loop that now exits when codex dies.
- **The pipeline's checkpoint file was tracked in git.** Task 192's merge committed `plans/checkpoint.json` into `staging`. Every later task worktree rewrote it, so the rebase refused a dirty tree, and a commit that untracked it failed the fence check. Fixed on September 2: untracked on `staging`, ignored, and exempt in both fence checks.
- **The auto-mode safety check blocked steps at random.** It denied a skill call and a workflow launch. Nothing in this repo can change that.

One cause of the first kind remains, and this plan fixes it. Task worktrees are still cut from the current branch of the launching checkout when an old worktree folder is reused. The launching branch is now fifteen commits ahead of `staging`. The next task cut from it would carry those commits into the rebase, and the fence check would fail the run.

## Amendments folded in

The adversarial review in `plans/cut-task-worktrees-from-staging-amendments.md` found six gaps in the first draft. The user decided:

- Amendment 1, replace the RED tests: accepted. Tests A, B, C below.
- Amendment 2, one exact ref and one resolved OID: accepted. `refs/heads/staging` everywhere. Test D.
- Amendment 3, guard every ref a `-B` reset can discard: accepted in full. Tests E, F, G, H.
- Amendment 4, recovery contract: recovery refuses with an error when `staging` is missing. Tests I, J.
- Amendment 5, one helper: accepted, with one change. Old lines are commented out, never deleted. Test K.
- Filtered test commands: the targeted file and the typecheck run unfiltered. The full suite is saved to a log and read from the log.

## Behavior, in plain words

1. One function, `resolveOrCreateStagingTip`, returns the commit OID of `refs/heads/staging`. If that branch is absent, the function creates it at `HEAD` and returns the new tip. If two processes both find it absent, both end at the same tip. A git failure other than "absent" throws.
2. Only `refs/heads/staging` is ever resolved. A tag named `staging` is never selected.
3. Before any `checkout -B task-N` or `worktree add -B task-N`, the code proves the branch `task-N` in that repository is absent, equal to the base OID, or an ancestor of the base OID. Otherwise the code refuses with "retained work" and changes nothing.
4. The retained-work check on an existing worktree folder looks at three things, in order: dirty files including untracked files and submodule state, the checked-out `HEAD`, and the `task-N` branch ref. Any one of them being retained is a refusal.
5. The retained-work check and the reset both use the one staging OID resolved after the lease is taken.
6. A reused worktree folder is reset to the staging OID.
7. A fresh worktree folder is cut from the staging OID. This already works.
8. Before `createBranchInEveryRepository` resets `task-N` in each populated submodule, each submodule's `task-N` ref is proved safe against that submodule's checked-out `HEAD`.
9. `recoverStaleTaskWorktreeLease` uses the same retained-work check with the staging OID. When `refs/heads/staging` is absent, it throws "local staging branch is missing" and touches nothing.
10. `buildWorkflowArguments` and `runAsCli` call `resolveOrCreateStagingTip` instead of their own copies of the check.

## Files

- Code: `scripts/prepareTasks.ts`. Functions touched: `worktreeHoldsRetainedWork` (line 175), `recoverStaleTaskWorktreeLease` (line 278), `createWorktreeForGroup` (line 298), `buildWorkflowArguments` (line 388), `runAsCli` (line 460). New functions go directly above `worktreeHoldsRetainedWork`.
- Tests: `tests/prepareTasks.test.ts`. Helpers already there: `git(repoRoot, ...args)`, `makeTempRepoWithCommit()`, `makeTempRepoWithLocalSubmodule()`, `spawnLeaseRacer(...)`, `waitForPath`, `captureSuccessfulChild`. Imports already there: `createWorktreeForGroup`, `recoverStaleTaskWorktreeLease`, `releaseTaskWorktreeLease`, `resolveTaskWorktreeConventionDirectory`, `existsSync`, `rmSync`, `writeFileSync`, `join`, `TaskGroup`.
- Not touched: `scripts/repositoryBranches.ts`. `createBranchInEveryRepository` stays as it is. The preflight runs before it.

## Commands

Targeted tests, unfiltered so the exit code is the runner's:

```
node --test tests/prepareTasks.test.ts
```

One test by name:

```
node --test --test-name-pattern='<test name>' tests/prepareTasks.test.ts
```

Typecheck:

```
npx tsc --noEmit
```

Full suite, saved then read:

```
npm test 2>&1 | tee /private/tmp/claude-501/-Users-matkatmusicllc-Programming-taskTools-86/7f028ec5-26a5-4892-a122-bd5b4142bf49/scratchpad/npm-test.log
rg -e '^✖' -e '^ℹ (tests|pass|fail)' /private/tmp/claude-501/-Users-matkatmusicllc-Programming-taskTools-86/7f028ec5-26a5-4892-a122-bd5b4142bf49/scratchpad/npm-test.log
```

Baseline before this plan: `ℹ tests 2532`, `ℹ pass 2527`, `ℹ fail 5`. The five: three in `tests/runMergePhase.test.ts`, one in `tests/taskWorkflowMergeStage.test.ts`, one in `tests/checkBlockers.test.ts`.

## Order of work

Part 1 adds eleven tests and confirms each one's RED or GREEN state by name. Part 2 changes the code in six steps. Part 3 verifies.

Every new test goes into `tests/prepareTasks.test.ts` directly after the test named `test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath` (ends at line 151), in the order A to K.

Every test uses this group unless it says otherwise:

```ts
const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
```

### Part 1, tests

#### Test A: a missing `staging` is created on reuse. Behavior 1.

```ts
test("test_createWorktreeForGroupCreatesMissingStagingBeforeReusingAWorktree", () => {
    // Setup: a first run cut the worktree folder and released its lease.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    // Setup: the staging branch is gone; the root checkout still sits on its original branch.
    git(repoRoot, "branch", "-D", "staging");
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action: a second run reuses the folder.
    const secondWorktreePath = createWorktreeForGroup(repoRoot, group, "run-2");
    // Verification: staging exists again at HEAD, and the reused folder sits at that exact commit.
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), headTip);
    assert.equal(git(secondWorktreePath, "rev-parse", "HEAD").trim(), headTip);
});
```

Expected today: RED. The reuse path never creates `staging`, so the first assertion throws.

#### Test B: the retained-work decision uses `staging`, not the launching branch. Behavior 4.

```ts
test("test_createWorktreeForGroupDoesNotCallTheStagingTipRetainedWhenTheLauncherDiverged", () => {
    // Setup: staging holds commit S; the original branch holds a different commit O.
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    git(repoRoot, "checkout", "-q", "-b", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "S");
    git(repoRoot, "checkout", "-q", originalBranch);
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    // Setup: a first run cut the folder at S and released its lease.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    // Test action and verification: a clean folder at the staging tip is not retained work.
    assert.doesNotThrow(() => createWorktreeForGroup(repoRoot, group, "run-2"));
});
```

Expected today: RED with `retained work`. S is not an ancestor of O.

#### Test C: a reusable folder is reset to `staging`, not the launching branch. Behavior 6.

```ts
test("test_createWorktreeForGroupResetsAReusableWorktreeToTheStagingTip", () => {
    // Setup: a first run cut the folder at the common base B and released its lease.
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    // Setup: staging moves to S; the original branch moves to a different commit O.
    git(repoRoot, "checkout", "-q", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "S");
    const stagingTip = git(repoRoot, "rev-parse", "refs/heads/staging").trim();
    git(repoRoot, "checkout", "-q", originalBranch);
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    // Test action: a second run reuses the folder.
    const secondWorktreePath = createWorktreeForGroup(repoRoot, group, "run-2");
    // Verification: the folder sits at S, holds the staging-only file, and lacks the original-only file.
    assert.equal(git(secondWorktreePath, "rev-parse", "HEAD").trim(), stagingTip);
    assert.equal(existsSync(join(secondWorktreePath, "staging-only.txt")), true);
    assert.equal(existsSync(join(secondWorktreePath, "original-only.txt")), false);
});
```

Expected today: RED on the first assertion. B is an ancestor of O, so the old guard allows reuse, then the old reset lands on O.

#### Test D: the branch wins over a tag of the same name. Behavior 2.

```ts
test("test_createWorktreeForGroupSelectsTheStagingBranchOverAStagingTag", () => {
    // Setup: the staging branch sits at B; a tag named staging sits at a later commit O.
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "branch", "staging");
    const branchTip = git(repoRoot, "rev-parse", "refs/heads/staging").trim();
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    git(repoRoot, "tag", "staging");
    // Test action: a fresh cut, then a reuse.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    const firstHead = git(firstWorktreePath, "rev-parse", "HEAD").trim();
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    const secondWorktreePath = createWorktreeForGroup(repoRoot, group, "run-2");
    // Verification: both cuts sit at the branch commit, never the tag commit.
    assert.equal(firstHead, branchTip);
    assert.equal(git(secondWorktreePath, "rev-parse", "HEAD").trim(), branchTip);
});
```

Expected today: RED. Git resolves a bare `staging` to `refs/tags/staging` before `refs/heads/staging`, so the fresh cut lands on O.

#### Test E: a hidden `task-N` branch with retained work blocks reuse. Behavior 3, existing folder.

```ts
test("test_createWorktreeForGroupRefusesWhenTheHiddenTaskBranchHoldsRetainedWork", () => {
    // Setup: a first run committed R on task-1, then moved the folder to a clean detached HEAD at the staging tip.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    writeFileSync(join(worktreePath, "retained.txt"), "retained\n");
    git(worktreePath, "add", "retained.txt");
    git(worktreePath, "commit", "-q", "-m", "R");
    const retainedTip = git(repoRoot, "rev-parse", "refs/heads/task-1").trim();
    git(worktreePath, "checkout", "-q", "--detach", "refs/heads/staging");
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    // Test action and verification: reuse refuses, and task-1 still points at R.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/task-1").trim(), retainedTip);
});
```

Expected today: RED. The checked-out HEAD is safe, so the old guard allows reuse and `checkout -B task-1` overwrites R.

#### Test F: an absent folder with a leftover unmerged `task-N` branch blocks a fresh cut. Behavior 3, absent folder.

```ts
test("test_createWorktreeForGroupRefusesToRecreateOverAnUnmergedTaskBranch", () => {
    // Setup: a first run committed R on task-1; its folder was removed but the branch stayed.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    writeFileSync(join(worktreePath, "retained.txt"), "retained\n");
    git(worktreePath, "add", "retained.txt");
    git(worktreePath, "commit", "-q", "-m", "R");
    const retainedTip = git(repoRoot, "rev-parse", "refs/heads/task-1").trim();
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    git(repoRoot, "worktree", "remove", "--force", worktreePath);
    assert.equal(existsSync(worktreePath), false);
    // Test action and verification: the fresh path refuses, and task-1 still points at R.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/task-1").trim(), retainedTip);
});
```

Expected today: RED. `worktree add -B task-1` overwrites R.

#### Test G: a submodule's hidden `task-N` branch with retained work blocks reuse. Behavior 8.

```ts
test("test_createWorktreeForGroupRefusesWhenASubmoduleTaskBranchHoldsRetainedWork", () => {
    // Setup: a first run committed R on the submodule's task-1, then moved the submodule back to its recorded gitlink, clean.
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    const submodulePath = join(worktreePath, "vendor");
    const gitlinkTip = git(worktreePath, "rev-parse", "HEAD:vendor").trim();
    writeFileSync(join(submodulePath, "retained.txt"), "retained\n");
    git(submodulePath, "add", "retained.txt");
    git(submodulePath, "commit", "-q", "-m", "R");
    const retainedTip = git(submodulePath, "rev-parse", "refs/heads/task-1").trim();
    git(submodulePath, "checkout", "-q", "--detach", gitlinkTip);
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    // Test action and verification: reuse refuses, and the submodule's task-1 still points at R.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(git(submodulePath, "rev-parse", "refs/heads/task-1").trim(), retainedTip);
});
```

Expected today: RED. The root is clean and safe, so reuse proceeds and `createBranchInEveryRepository` overwrites the submodule's task-1.

#### Test H: an untracked file is retained work. Behavior 4.

```ts
test("test_createWorktreeForGroupRefusesWhenTheWorktreeHoldsAnUntrackedFile", () => {
    // Setup: a first run left an untracked file behind and released its lease.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    writeFileSync(join(worktreePath, "untracked.txt"), "not yet added\n");
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    // Test action and verification: reuse refuses, and the file survives.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(existsSync(join(worktreePath, "untracked.txt")), true);
});
```

Expected today: GREEN. `git status --porcelain` already lists untracked files. This test pins that behavior so the explicit flags in Step 3 cannot lose it.

#### Test I: recovery judges retained work against `staging`. Behavior 9.

```ts
test("test_recoverStaleTaskWorktreeLeaseJudgesRetainedWorkAgainstStaging", () => {
    // Setup: staging holds S, the original branch holds a different O, and a crashed run left its lease on a clean folder at S.
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    git(repoRoot, "checkout", "-q", "-b", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "S");
    git(repoRoot, "checkout", "-q", originalBranch);
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "stale-run");
    // Test action and verification: recovery releases the lease instead of calling S retained.
    assert.doesNotThrow(() => recoverStaleTaskWorktreeLease(repoRoot, worktreePath));
    assert.equal(existsSync(`${worktreePath}.lease`), false);
});
```

Expected today: RED with `retained work`.

#### Test J: recovery refuses when `staging` is missing. Behavior 9.

```ts
test("test_recoverStaleTaskWorktreeLeaseRefusesWhenStagingIsMissing", () => {
    // Setup: a crashed run left its lease; the staging branch is gone.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "stale-run");
    git(repoRoot, "branch", "-D", "staging");
    // Test action and verification: recovery refuses and leaves the lease in place.
    assert.throws(() => recoverStaleTaskWorktreeLease(repoRoot, worktreePath), /staging branch is missing/);
    assert.equal(existsSync(`${worktreePath}.lease`), true);
});
```

Expected today: RED. The old check reads the current branch and releases the lease.

#### Test K: two processes with no `staging` both start from the same staging tip. Behavior 1.

Model on `test_twoBarrierSynchronizedPrepareProcessesHaveExactlyOneOwnerOfTheSameCleanWorktree` (line 176). Use group ids 1 and 2 so both must succeed.

```ts
test("test_twoPrepareProcessesWithNoStagingBranchBothStartFromTheSameStagingTip", async () => {
    // Setup: a repo with no staging branch, and two prepare processes for two different groups held at a barrier.
    const repoRoot = makeTempRepoWithCommit();
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();
    const readyA = join(repoRoot, "ready-a");
    const readyB = join(repoRoot, "ready-b");
    const goFile = join(repoRoot, "go");
    const a = spawnLeaseRacer(repoRoot, 1, "run-a", readyA, goFile);
    const b = spawnLeaseRacer(repoRoot, 2, "run-b", readyB, goFile);
    try {
        await waitForPath(readyA);
        await waitForPath(readyB);
        // Test action: release both at once.
        writeFileSync(goFile, "go\n");
        const [outA, outB] = await Promise.all([captureSuccessfulChild(a), captureSuccessfulChild(b)]);
        const results = [JSON.parse(outA), JSON.parse(outB)] as Array<{ ok: boolean, worktreePath?: string, message?: string }>;
        // Verification: both succeed, staging exists at HEAD, and both folders sit at that tip.
        assert.equal(results[0]!.ok, true, results[0]!.message);
        assert.equal(results[1]!.ok, true, results[1]!.message);
        assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), headTip);
        assert.equal(git(results[0]!.worktreePath!, "rev-parse", "HEAD").trim(), headTip);
        assert.equal(git(results[1]!.worktreePath!, "rev-parse", "HEAD").trim(), headTip);
    } finally {
        rmSync(resolveTaskWorktreeConventionDirectory(repoRoot), { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});
```

Expected today: RED on most runs. The loser's `git branch staging` throws "already exists". Run it three times by name. If all three pass today, note that in the report and continue; the test still pins the behavior.

#### Confirm Part 1

Run each of A to K once by name with `--test-name-pattern`. Record the result per test. Then run the whole file once. Expected: `ℹ fail 9` or `ℹ fail 10` depending on K, and `ℹ pass` equal to 47 plus the green new tests. Do not start Part 2 until each RED test failed for the reason stated under it.

### Part 2, code

All edits are in `scripts/prepareTasks.ts`. Every replaced line stays in the file as a comment, directly above its replacement.

#### Step 1: add the staging helpers. Behavior 1 and 2.

Insert directly above `function worktreeHoldsRetainedWork` (line 175, after the comment on line 174 stays with that function):

```ts
export const STAGING_REF = "refs/heads/staging";

// null means the branch is absent. Any other git failure throws; status 1 is git's "not found" for --verify --quiet.
export function readStagingTip(repoRoot: string): string | null {
    const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${STAGING_REF}^{commit}`], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
    if (result.status === 1) return null;
    throw new Error(`git rev-parse ${STAGING_REF} failed in "${repoRoot}": ${result.stderr}`);
}

// Creates from HEAD, which may be detached. A racing creator's failure is fine as long as the ref exists afterwards.
export function resolveOrCreateStagingTip(repoRoot: string): string {
    const found = readStagingTip(repoRoot);
    if (found !== null) return found;
    const created = spawnSync("git", ["-C", repoRoot, "branch", "staging"], { encoding: "utf8" });
    const foundAfterCreate = readStagingTip(repoRoot);
    if (foundAfterCreate === null) {
        throw new Error(`could not create ${STAGING_REF} in "${repoRoot}": ${created.stderr}`);
    }
    return foundAfterCreate;
}
```

Run `node --test tests/prepareTasks.test.ts`. Expected: same results as the end of Part 1. Nothing calls these yet.

#### Step 2: add the ref-safety helpers. Behavior 3.

Insert directly below the helpers from Step 1:

```ts
function commitHoldsRetainedWork(repoPath: string, commit: string, baseTip: string): number {
    if (commit === baseTip) return WORKTREE_HOLDS_NO_RETAINED_WORK;
    const ancestry = spawnSync("git", ["-C", repoPath, "merge-base", "--is-ancestor", commit, baseTip], { stdio: "ignore" });
    if (ancestry.status === 0) return WORKTREE_HOLDS_NO_RETAINED_WORK;
    return WORKTREE_HOLDS_RETAINED_WORK;
}

// A branch ref that a -B reset is about to overwrite is safe only when absent, at the base, or behind it.
function branchRefHoldsRetainedWork(repoPath: string, branchName: string, baseTip: string): number {
    const found = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}^{commit}`], { encoding: "utf8" });
    if (found.status !== 0) return WORKTREE_HOLDS_NO_RETAINED_WORK;
    return commitHoldsRetainedWork(repoPath, found.stdout.trim(), baseTip);
}

// createBranchInEveryRepository resets task-N in every populated submodule; each one is checked against its own checked-out HEAD, which init just set to the recorded gitlink.
function submoduleTaskBranchesHoldRetainedWork(worktreePath: string, branchName: string): number {
    for (const path of submodulePaths(worktreePath, currentBranchName(worktreePath))) {
        const submodulePath = join(worktreePath, path);
        const gitlinkTip = execFileSync("git", ["-C", submodulePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        if (branchRefHoldsRetainedWork(submodulePath, branchName, gitlinkTip) === WORKTREE_HOLDS_RETAINED_WORK) {
            return WORKTREE_HOLDS_RETAINED_WORK;
        }
    }
    return WORKTREE_HOLDS_NO_RETAINED_WORK;
}
```

Run the targeted file. Expected: unchanged.

#### Step 3: rewrite `worktreeHoldsRetainedWork`. Behavior 4 and 5.

Comment out the whole existing body (lines 175 to 187). Add below it:

```ts
function worktreeHoldsRetainedWork(worktreePath: string, repoRoot: string, branchName: string, stagingTip: string): number {
    const status = execFileSync(
        "git",
        ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
        { encoding: "utf8" },
    );
    if (status.trim().length > 0) return WORKTREE_HOLDS_RETAINED_WORK;
    const worktreeHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (commitHoldsRetainedWork(repoRoot, worktreeHead, stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
        return WORKTREE_HOLDS_RETAINED_WORK;
    }
    return branchRefHoldsRetainedWork(repoRoot, branchName, stagingTip);
}
```

`npx tsc --noEmit` now reports the two callers with the old arity. That is expected until Step 4 and Step 5.

#### Step 4: rewrite the two paths in `createWorktreeForGroup`. Behavior 3, 5, 6, 7, 8.

Replace the body from `let lease: TaskWorktreeLease;` through the end of the function. Comment out every old line that changes. The new body:

```ts
    let lease: TaskWorktreeLease;
    if (existsSync(worktreePath)) {
        // Lease first, then resolve: the safety decision and the reset must see the same staging commit.
        lease = acquireTaskWorktreeLease(worktreePath, runId);
        try {
            const stagingTip = resolveOrCreateStagingTip(repoRoot);
            if (worktreeHoldsRetainedWork(worktreePath, repoRoot, branchName, stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
                throw new Error(
                    `worktree at "${worktreePath}" holds retained work from a previous run; `
                    + `resolve or remove it before re-preparing task-${group.groupId}`,
                );
            }
            if (submoduleTaskBranchesHoldRetainedWork(worktreePath, branchName) === WORKTREE_HOLDS_RETAINED_WORK) {
                throw new Error(
                    `worktree at "${worktreePath}" holds retained work on a submodule task branch; `
                    + `resolve or remove it before re-preparing task-${group.groupId}`,
                );
            }
            execFileSync(
                "git",
                ["-C", worktreePath, "checkout", "--force", "-B", branchName, stagingTip],
                { stdio: "ignore" },
            );
        } catch (error) {
            releaseTaskWorktreeLease(lease);
            throw error;
        }
    } else {
        mkdirSync(dirname(worktreePath), { recursive: true });
        lease = acquireTaskWorktreeLease(worktreePath, runId);
        try {
            const stagingTip = resolveOrCreateStagingTip(repoRoot);
            if (branchRefHoldsRetainedWork(repoRoot, branchName, stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
                throw new Error(
                    `branch "${branchName}" holds retained work from a previous run; `
                    + `resolve or delete it before re-preparing task-${group.groupId}`,
                );
            }
            execFileSync(
                "git",
                ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, stagingTip],
                { stdio: "ignore" },
            );
        } catch (error) {
            releaseTaskWorktreeLease(lease);
            throw error;
        }
    }
    // A submodule-init or branch-creation failure gets the same treatment: release, don't orphan.
    try {
        initializeSubmodulesInWorktree(worktreePath);
        if (submoduleTaskBranchesHoldRetainedWork(worktreePath, branchName) === WORKTREE_HOLDS_RETAINED_WORK) {
            throw new Error(
                `worktree at "${worktreePath}" holds retained work on a submodule task branch; `
                + `resolve or remove it before re-preparing task-${group.groupId}`,
            );
        }
        createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath, currentBranchName(worktreePath))], branchName);
    } catch (error) {
        releaseTaskWorktreeLease(lease);
        throw error;
    }
    return worktreePath;
```

Notes the implementer must keep:

- In the reuse path the submodule preflight runs before the root reset, so no repository is reset before every check passes. Submodules already exist there.
- In the fresh path the submodule preflight can only run after `initializeSubmodulesInWorktree`, because no submodule repository exists before it. The root `task-N` ref was proved safe before `worktree add -B`, so the only mutation before that check loses nothing.
- The old four-line `stagingVerify` block in the fresh path is commented out, not deleted.
- On the reuse path, a refusal now releases the lease this call took. Before, the refusal happened before the lease. The race test at line 176 still holds: the loser fails on the lease, never on the refusal.
- Two known limits of the reuse-path submodule check, both on the safe side. Add one `ponytail:` comment above `submoduleTaskBranchesHoldRetainedWork` naming them. First: it compares against the submodule's current `HEAD`, not the gitlink `staging` records. When `staging` moved the gitlink, a submodule task branch that is behind the new gitlink can still be called retained. That is a false refusal, never a loss. Second: `submodulePaths` needs the worktree's current branch name. A reused folder left on a detached `HEAD` that passed the root check makes that call throw. The run stops with git's message instead of resetting.

Run the targeted file. Expected: A to H GREEN, I and J still RED, K GREEN.

#### Step 5: rewrite `recoverStaleTaskWorktreeLease`. Behavior 9.

Replace the retained-work `if` (line 285 before the edits above). Comment out the old line. New lines:

```ts
    const stagingTip = readStagingTip(repoRoot);
    if (stagingTip === null) {
        throw new Error(`local staging branch is missing in "${repoRoot}"; create it before releasing the stale lease at "${worktreePath}"`);
    }
    if (worktreeHoldsRetainedWork(worktreePath, repoRoot, basename(worktreePath), stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
        throw new Error(`worktree at "${worktreePath}" holds retained work; resolve or remove it before releasing its stale lease`);
    }
```

`basename(worktreePath)` is `task-N`, the same string `branchNameForGroup` produces. `basename` is already imported.

Run the targeted file. Expected: `ℹ fail 0`.

#### Step 6: route the two other copies through the helper. Behavior 10.

In `buildWorkflowArguments`, comment out the four `stagingVerify` lines and add:

```ts
    resolveOrCreateStagingTip(repoRoot);
```

In `runAsCli`, comment out the four `stagingVerify` lines inside the `try` and add the same call in their place.

Run `npx tsc --noEmit`. Expected: no errors. Run the targeted file. Expected: `ℹ fail 0`.

### Part 3, verification

1. `node --test tests/prepareTasks.test.ts`: exit code 0.
2. `npx tsc --noEmit`: exit code 0.
3. Full suite, one subagent, using the two-command form under Commands. The subagent reports the complete list of `✖` lines and the three `ℹ` summary lines. Expected: the same five failures as the baseline and no others. A missing `ℹ tests` line means the runner crashed; report that as a failure, not as green.
4. For every `✖` beyond the five, the subagent does this, in order:
   1. Read the failing test.
   2. Decide which of two things the fixture models. Case one: the fixture's moving branch stands in for the integration base, and the test expects the task worktree to follow it. That test is obsolete under behavior 6. Fix the fixture so `staging` carries the commit, with `git(repoRoot, "branch", "-f", "staging")` after the commit. Leave the assertions alone. Case two: the fixture's moving branch deliberately models an unrelated launching checkout, or the failure is not about which branch was followed. That is a bug in Part 2. Fix `scripts/prepareTasks.ts`, not the test.
   3. When the two cases cannot be told apart from the test's comments and assertions, stop and report the test name instead of guessing.
   4. Report each changed test by name and which case applied.

## Acceptance

- Fresh and reused task worktrees start at the OID of `refs/heads/staging`, whatever branch the launching checkout is on. Tests A, C, D, K.
- A tag named `staging` is never selected. Test D.
- A clean folder at an older staging commit is reusable when the launching branch diverged. Test B.
- Dirty files, untracked files, a retained checked-out commit, a hidden root `task-N` ref, a leftover `task-N` ref with no folder, and a hidden submodule `task-N` ref each cause a refusal with no ref or file loss. Existing test at line 205, plus H, E, F, G.
- Recovery uses the staging OID and refuses when `staging` is missing. Tests I, J.
- Targeted file: zero failures. Typecheck: zero errors. Full suite: exactly the five baseline failures, listed by name in the report.
- No test outside Part 1 is edited except under Part 3 case one, and each such edit is named in the report.

## Out of scope

- `scripts/tackle-tasks/shared/resolveTaskRun.ts:58` reports the current branch as `sourceBranch`. No pipeline step reads that field. Leave it.
- `scripts/mergeTaskWorktrees.ts:869` reads the current branch for the `--discover` CLI, which the merge-worktree-tasks skill uses, not the pipeline. Leave it.
- The five baseline failures. Do not touch them.

## Commit

Nothing is committed until the user says "commit".
