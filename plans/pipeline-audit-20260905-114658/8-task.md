# Task 8 plan — resolveOrCreateStagingTip must never force-move an existing staging ref

## Scope confirmation

- `scripts/prepareTasks.ts`
  - Lines 186–210, today (verified live):
    ```ts
    export function resolveOrCreateStagingTip(repoRoot: string): string {
        const found = readStagingTip(repoRoot);
        if (found !== null) {
            const headTip = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
            if (found === headTip) return found;
            const stagingIsMergedIntoHead = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", found, "HEAD"], { stdio: "ignore" });
            if (stagingIsMergedIntoHead.status !== 0) return found;
            const moved = spawnSync("git", ["-C", repoRoot, "branch", "-f", "staging", "HEAD"], { encoding: "utf8" });
            if (moved.status !== 0) {
                // git refuses to move a branch a worktree has checked out, so fast-forward it inside that worktree.
                const stagingCheckout = moved.stderr.match(/used by worktree at '([^']+)'/)?.[1];
                if (stagingCheckout === undefined) {
                    throw new Error(`${STAGING_REF} is merged into HEAD but could not be moved in "${repoRoot}": ${moved.stderr.trim()}`);
                }
                execFileSync("git", ["-C", stagingCheckout, "merge", "--ff-only", headTip], { stdio: ["ignore", "ignore", "inherit"] });
            }
            return readStagingTip(repoRoot)!;
        }
        const created = spawnSync("git", ["-C", repoRoot, "branch", "staging"], { encoding: "utf8" });
        const foundAfterCreate = readStagingTip(repoRoot);
        if (foundAfterCreate === null) {
            throw new Error(`could not create ${STAGING_REF} in "${repoRoot}": ${created.stderr}`);
        }
        return foundAfterCreate;
    }
    ```
    When staging exists, is fully merged into `HEAD`, and is not already at `HEAD`, this force-moves the `staging` branch ref to the caller's `HEAD` (`branch -f`), falling back to a `merge --ff-only` inside whatever worktree has `staging` checked out when the force-move is refused. Both paths put the current session's `HEAD` into `staging` without pipeline review — the bug task 8 fixes.
  - Four call sites, all read-only consumers of the returned tip string; none change:
    - Line 439, inside `createWorktreeForGroup`'s "worktree folder exists" branch.
    - Line 465, inside `createWorktreeForGroup`'s "worktree folder absent" branch.
    - Line 547, inside `buildWorkflowArguments`, called for its side effect only (return value discarded).
    - Line 633, inside `runAsCli`, called for its side effect only (return value discarded).
    Confirmed live via `rg -n "resolveOrCreateStagingTip" scripts/prepareTasks.ts`; no other file in the repo calls it (`rg -n "resolveOrCreateStagingTip" -g '*.ts'` matches only `scripts/prepareTasks.ts`).

- `tests/prepareTasks.test.ts`
  - Lines 143–159, today, `test_createWorktreeForGroupMovesAMergedStagingToHead`: builds a repo where `staging` is merged into `HEAD`, calls `createWorktreeForGroup`, and asserts `staging` **moved** to `HEAD` (`assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), headTip)`). This asserts the exact behavior task 8 removes — it must change.
  - Lines 161–176, today, `test_createWorktreeForGroupFastForwardsAMergedStagingThatIsCheckedOutElsewhere`: same setup, but `staging` is checked out in a second worktree so `branch -f` fails and the `merge --ff-only` fallback runs; asserts both the root repo's `staging` and the second worktree's `HEAD` land on `headTip`. This asserts the fallback path task 8 removes — it must change.
  - No other test in this file, `tests/prepareTasksIntegration.test.ts`, or `tests/prepareTasksWorktreePath.test.ts` references `resolveOrCreateStagingTip`, the force-move, or the ff-only fallback (confirmed via `rg -n "resolveOrCreateStagingTip|MovesAMergedStagingToHead|FastForwardsAMergedStaging" -g '*.ts'`).

## Steps

### Step 1 — red: prove staging stays put when it is merged into a diverged HEAD

Replace `test_createWorktreeForGroupMovesAMergedStagingToHead` (lines 143–159) in place — same setup, new name and assertions, since the old name and assertions describe behavior this task deletes:

```ts
test("test_createWorktreeForGroupKeepsAMergedStagingAtItsExistingTip", () => {
    // Setup: staging sits at B; the current branch has moved on to O, so staging is fully merged into HEAD.
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "branch", "staging");
    const oldStagingTip = git(repoRoot, "rev-parse", "staging").trim();
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();
    assert.notEqual(oldStagingTip, headTip);
    // Test action: cut a worktree.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Verification: staging never moved, and the new worktree still sits at the old staging tip.
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), oldStagingTip);
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), oldStagingTip);
});
```

Running it now (before Step 2's production edit) fails: `refs/heads/staging` reads `headTip`, not `oldStagingTip`, because the current code still force-moves it.

### Step 2 — red: invert the checked-out-elsewhere test

`test_createWorktreeForGroupFastForwardsAMergedStagingThatIsCheckedOutElsewhere` (lines 161–176) is still a distinct Git topology worth its own regression test after Step 3 — a `staging` branch with an attached worktree is a different arrangement from a plain branch ref, and only a test built on that exact arrangement guards against a future change reintroducing a side effect specific to it. Replace its body in place (same name is wrong now — rename it) rather than retiring it:

```ts
test("test_createWorktreeForGroupDoesNotMoveAStagingBranchCheckedOutInAnotherWorktree", () => {
    // Setup: staging is merged into HEAD, but a second worktree has it checked out.
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "branch", "staging");
    const oldStagingTip = git(repoRoot, "rev-parse", "staging").trim();
    const stagingWorktree = mkdtempSync(join(tmpdir(), "staging-checkout-"));
    git(repoRoot, "worktree", "add", "-q", stagingWorktree, "staging");
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    // Test action: cut a worktree.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Verification: staging never moved, the other worktree's HEAD never moved, and the new worktree sits at the old staging tip.
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), oldStagingTip);
    assert.equal(git(stagingWorktree, "rev-parse", "HEAD").trim(), oldStagingTip);
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), oldStagingTip);
});
```

Running it now (before Step 3's production edit) fails the same way Step 1's does: `refs/heads/staging` and the second worktree's `HEAD` both still read `headTip` after the commit on `O`, because the current code still force-moves and fast-forwards them.

### Step 3 — green: make `resolveOrCreateStagingTip` return an existing tip as-is

In `scripts/prepareTasks.ts`, inside `resolveOrCreateStagingTip` (lines 186–210), comment out the `headTip`/merge-check/force-move/ff-only block and replace it with a direct return of the existing tip:

```ts
export function resolveOrCreateStagingTip(repoRoot: string): string {
    const found = readStagingTip(repoRoot);
    if (found !== null) {
        // RETIRED (task 8): staging holds work that passed the pipeline for review, so moving it to an
        // arbitrary session HEAD put unreviewed commits into staging. An existing tip is now used as-is;
        // pipeline merge code is the only writer to an existing staging branch.
        // const headTip = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        // if (found === headTip) return found;
        // const stagingIsMergedIntoHead = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", found, "HEAD"], { stdio: "ignore" });
        // if (stagingIsMergedIntoHead.status !== 0) return found;
        // const moved = spawnSync("git", ["-C", repoRoot, "branch", "-f", "staging", "HEAD"], { encoding: "utf8" });
        // if (moved.status !== 0) {
        //     // git refuses to move a branch a worktree has checked out, so fast-forward it inside that worktree.
        //     const stagingCheckout = moved.stderr.match(/used by worktree at '([^']+)'/)?.[1];
        //     if (stagingCheckout === undefined) {
        //         throw new Error(`${STAGING_REF} is merged into HEAD but could not be moved in "${repoRoot}": ${moved.stderr.trim()}`);
        //     }
        //     execFileSync("git", ["-C", stagingCheckout, "merge", "--ff-only", headTip], { stdio: ["ignore", "ignore", "inherit"] });
        // }
        // return readStagingTip(repoRoot)!;
        return found;
    }
    const created = spawnSync("git", ["-C", repoRoot, "branch", "staging"], { encoding: "utf8" });
    const foundAfterCreate = readStagingTip(repoRoot);
    if (foundAfterCreate === null) {
        throw new Error(`could not create ${STAGING_REF} in "${repoRoot}": ${created.stderr}`);
    }
    return foundAfterCreate;
}
```

Do not remove the `execFileSync` import even though this function no longer calls it — `createWorktreeForGroup` still uses it elsewhere in the file (confirmed via `rg -n "execFileSync" scripts/prepareTasks.ts`, multiple hits outside this function).

At this point Step 1's new test passes: `found` is returned unchanged regardless of `HEAD`.

### Step 4 — confirm the untouched tests still hold

Re-read (do not edit) these two tests, both already in the file and both already asserting the behavior this task keeps:

- `test_createWorktreeForGroupCreatesStagingFromHeadWhenItIsMissing` (lines 130–141) — staging absent, created from `HEAD`. Untouched code path (`found === null` branch); no edit needed.
- `test_createWorktreeForGroupDoesNotCallTheStagingTipRetainedWhenTheLauncherDiverged` (lines 204–222) — staging and the launcher branch diverge with neither an ancestor of the other; `resolveOrCreateStagingTip` returns `found` unchanged either way (old code: `stagingIsMergedIntoHead.status !== 0` was already true here, so this scenario already returned `found` before this task; new code: same, unconditionally). No edit needed; note this in the PR/commit description so a reviewer does not re-derive it.

## Verification

```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```

If it does not report "all passing", run `Bash(npm test 2>&1 | tail -50)` and fix the codebase (not the tests, unless a test asserts retired behavior per Step 2) until it does. Do not re-run `npm test` again once it reports "all passing".
