# Task 177 Plan: Stop re-preparing a failed task from force-resetting its retained worktree

## Problem

`createWorktreeForGroup` in `scripts/prepareTasks.ts`, when the worktree
directory for a task already exists on disk, unconditionally runs
`git checkout --force -B <branch> <sourceBranch>` inside it. If a previous
run's worker left commits or uncommitted files in that worktree (the
failure-retention path other tooling relies on for inspection/recovery),
this force-checkout silently destroys them.

`tests/prepareTasks.test.ts`'s
`test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip`
currently sets up exactly that scenario and asserts the prior commit and
file are gone — i.e. it validates the data loss. It must become a
retention assertion: re-preparation must refuse to discard retained work.

## Fix approach

Add a guard, `worktreeHoldsRetainedWork`, that inspects the existing
worktree before any force-checkout:

- If the worktree has uncommitted changes (`git status --porcelain` is
  non-empty), it holds retained work.
- Otherwise, compare the worktree's `HEAD` commit to the source branch's
  tip commit (`currentBranchName(repoRoot)` resolved to a commit hash via
  `git rev-parse`). If they're equal, there is nothing beyond the source
  tip — safe. If the worktree's `HEAD` is an ancestor of the source tip
  (`git merge-base --is-ancestor`), it's stale but has no extra commits —
  safe. Otherwise the worktree carries commits the source branch does not
  have — retained work.

When `createWorktreeForGroup` finds an existing worktree that holds
retained work, it throws instead of force-checking-out, requiring an
explicit cleanup/reset decision outside of normal preparation. When the
existing worktree holds no retained work, behavior is unchanged (the
existing `checkout --force -B` re-bases it onto the source tip, covering
the plain reuse/rebase case with nothing to lose).

This is self-contained inside `scripts/prepareTasks.ts` — no other file
needs editing for this behavior (the brief notes a future recovery path
could build on task 176's worktree-discovery work, but this task's own fix
does not require it: refusing to discard is sufficient to satisfy "require
an explicit cleanup/reset decision before discarding it").

## Edits to scripts/prepareTasks.ts

### Edit 1 — insert the `worktreeHoldsRetainedWork` guard function

Current text (lines 126–135):

```
// `git worktree add` leaves submodule directories empty; a worker needs them populated.
function initializeSubmodulesInWorktree(worktreePath: string): void {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return;
    execFileSync(
        "git",
        ["-C", worktreePath, "submodule", "update", "--init", "--recursive"],
        { stdio: ["ignore", "ignore", "inherit"] },
    );
}

export function createWorktreeForGroup(repoRoot: string, group: TaskGroup): string {
```

New text:

```
// `git worktree add` leaves submodule directories empty; a worker needs them populated.
function initializeSubmodulesInWorktree(worktreePath: string): void {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return;
    execFileSync(
        "git",
        ["-C", worktreePath, "submodule", "update", "--init", "--recursive"],
        { stdio: ["ignore", "ignore", "inherit"] },
    );
}

// A two-lap failure can leave commits or edits in the worktree for inspection/recovery.
function worktreeHoldsRetainedWork(worktreePath: string, repoRoot: string): boolean {
    const status = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8" });
    if (status.trim().length > 0) return true;
    const worktreeHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sourceTip = execFileSync("git", ["-C", repoRoot, "rev-parse", currentBranchName(repoRoot)], { encoding: "utf8" }).trim();
    if (worktreeHead === sourceTip) return false;
    try {
        execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", worktreeHead, sourceTip], { stdio: "ignore" });
        return false;
    } catch {
        return true;
    }
}

export function createWorktreeForGroup(repoRoot: string, group: TaskGroup): string {
```

(`currentBranchName` and `execFileSync` are already imported at the top of
the file — lines 2 and 10 — so no import changes are needed.)

### Edit 2 — refuse to force-checkout over retained work

Current text (lines 139–145, inside `createWorktreeForGroup`, unchanged by
Edit 1 since that edit only inserts text above this block):

```
    if (existsSync(worktreePath)) {
        // A worktree left by an earlier run holds that run's commits; re-base it on the source branch tip.
        execFileSync(
            "git",
            ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
            { stdio: "ignore" },
        );
    } else {
```

New text:

```
    if (existsSync(worktreePath)) {
        if (worktreeHoldsRetainedWork(worktreePath, repoRoot)) {
            throw new Error(
                `worktree at "${worktreePath}" holds retained work from a previous run; `
                + `resolve or remove it before re-preparing task-${group.groupId}`,
            );
        }
        // No retained work: safe to re-base this worktree onto the source branch tip.
        execFileSync(
            "git",
            ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
            { stdio: "ignore" },
        );
    } else {
```

No other lines in `scripts/prepareTasks.ts` change. Every other exported
function (`selectRequestedTasks`, `generateRunId`, `resolveMergeScriptPath`,
`resolveRunArgumentsPath`, `resolveRunOutcomesPath`, `resolveStepOutputsPath`,
`resolveMergePhaseScriptPath`, `attachOperationBranch`, `writeTaskBriefFile`,
`buildWorkflowArguments`, `loadRepositoryManifest`, `runAsCli`) is untouched
by this fix and needs no edit.

## Edits to tests/prepareTasks.test.ts

### Edit 1 — replace the data-loss assertion with a retention assertion

Current text (lines 84–103):

```
test("test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip", () => {
    // Setup: a worktree left behind by an earlier run, holding that run's commit.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    writeFileSync(join(worktreePath, "stale.txt"), "from the previous run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "previous run");
    // Setup: the source branch has since moved on.
    writeFileSync(join(repoRoot, "fresh.txt"), "landed since\n");
    git(repoRoot, "add", "fresh.txt");
    git(repoRoot, "commit", "-q", "-m", "fresh work");
    const sourceTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action: a second run hands a worker the same path.
    createWorktreeForGroup(repoRoot, group);
    // Verification: the worker gets the source branch tip, not the earlier run's codebase.
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), sourceTip);
    assert.equal(existsSync(join(worktreePath, "fresh.txt")), true);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), false);
});
```

New text:

```
test("test_createWorktreeForGroupRefusesToDiscardAStaleWorktreesRetainedWork", () => {
    // Setup: a worktree left behind by an earlier run, holding that run's commit.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    writeFileSync(join(worktreePath, "stale.txt"), "from the previous run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "previous run");
    const retainedHead = git(worktreePath, "rev-parse", "HEAD").trim();
    // Setup: the source branch has since moved on.
    writeFileSync(join(repoRoot, "fresh.txt"), "landed since\n");
    git(repoRoot, "add", "fresh.txt");
    git(repoRoot, "commit", "-q", "-m", "fresh work");
    // Test action and verification: re-preparation refuses to silently discard retained work.
    assert.throws(() => createWorktreeForGroup(repoRoot, group), /retained work/);
    // Verification: the previous run's commit and file are still there for inspection or recovery.
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), retainedHead);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), true);
});
```

No other test in `tests/prepareTasks.test.ts` changes. Verified against
the new guard's behavior:

- `test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch` (lines
  67–74): the worktree does not exist yet, so the `else` branch runs;
  `worktreeHoldsRetainedWork` is never called. Unaffected.
- `test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath`
  (lines 76–82): second call finds the worktree's `HEAD` still equal to
  the (unchanged) source tip, so `worktreeHoldsRetainedWork` returns
  `false` and the existing force-checkout runs as before. Unaffected.
- `test_createWorktreeForGroupPopulatesSubmoduleWorkingTrees` (lines
  105–113), `test_createWorktreeForGroupThrowsWhenSubmoduleInitFails`
  (lines 115–122), `test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch`
  (lines 215–221): each calls `createWorktreeForGroup` once against a
  freshly created temp repo, so the worktree does not pre-exist. Unaffected.
- All `buildWorkflowArguments*` tests (lines 124–150, 223–269): each uses
  a fresh temp repo and calls `createWorktreeForGroup` (via
  `buildWorkflowArguments`) at most once per group per test. Unaffected.

## Verification

Run:

```
node --test tests/prepareTasks.test.ts
```

Expected: all tests pass, including the renamed
`test_createWorktreeForGroupRefusesToDiscardAStaleWorktreesRetainedWork`,
with 0 failures.

Run the full suite to confirm no other test depended on the old
force-discard behavior:

```
npm test
```

Expected: all tests pass, 0 failures.
