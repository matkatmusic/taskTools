# When a user launches a tackle-tasks run and their current branch has diverged from staging, the pipeline merges or fast-forwards staging in one shared checkout folder named awaitingTesting. That folder is always on the staging branch, never on the user's branch. If the folder is left in a broken state and holds no work, the pipeline repairs it on its own, and no run throws because of it.

Word use: `staging` is a branch. `awaitingTesting` is a folder. The branch name never changes.
Work rule: a folder holds work when `git diff --quiet` exits non-zero, or `git ls-files --others --exclude-standard` prints a line. Nothing else counts.

1. Start: the shared checkout folder is `<tmp>/taskTools-wt/<repo>-<hash>/staging` (`scripts/tackle-tasks/shared/stagingWorktree.ts:12`); the guard at `stagingWorktree.ts:31-35` throws when the folder is on the wrong branch and `git status --porcelain` is not empty; the merge tool at `scripts/merge-worktree-tasks/mergeTaskWorktrees.ts:888,895` passes the user's current branch instead of `staging`.

2. The shared checkout folder is named `awaitingTesting`.
   WHY: the folder and the branch share the word `staging` today, so people and code mix them up.
   HOW: comment out the `join(..., "staging")` return at `stagingWorktree.ts:12` and return `join(..., "awaitingTesting")`. Add one test in `scripts/tackle-tasks/shared/stagingWorktree.test.ts` that checks the basename of `stagingWorktreePath()`. No test hard-codes the folder name as a path part.

3. `ensureStagingWorktree` rebuilds the shared `awaitingTesting` folder on the expected branch when the folder is on the wrong branch and holds no work.
   WHY: after a user commit on the folder's branch, `git status --porcelain` is never empty again, so the check at `stagingWorktree.ts:32-35` throws on every run (task 29 in relationship-mermaid). No work is in the folder; git only reports a stale index.
   HOW: in `addOrVerifyLinkedWorktree`, comment out the `status --porcelain` check and the `rmSync` at `stagingWorktree.ts:32-38`. Write the work rule inline. Holds work: throw with the folder path, the found branch, and `git status --porcelain`. Holds no work: `git worktree remove --force`, `git worktree prune`, `git worktree add --force`. Add two tests in `tests/stagingWorktreeStale.test.ts`. The first puts the folder on the user's branch, commits on that branch in the source checkout, and expects a rebuild on `staging`. The second adds an untracked file and expects the throw.

4. The old folder named `staging` is gone from every repo on this machine that ran the pipeline.
   WHY: the old folder still holds the `staging` branch. `git branch -f staging` refuses while another checkout holds the branch, so the first run after step 2 fails.
   HOW: by hand, once per repo. Run `git -C <repo> worktree list` to find the `.../taskTools-wt/<repo>-<hash>/staging` line. Then run `git -C <repo> worktree remove --force <that path>` and `git -C <repo> worktree prune`. No pipeline code, no test. Only this machine runs the pipeline.

5. The merge tool checks out `staging` in the shared `awaitingTesting` folder, never the user's branch.
   WHY: `runMergeCli` at `mergeTaskWorktrees.ts:888,895` passes `parentSource.sourceBranch`, the user's current branch. That put the folder on `develop` on 2026-09-14.
   HOW: comment out the two lines and write them again with `"staging"` for both `ensureStagingWorktree` and `mergeGroupBranchIntoRepo`. `MERGE_WORKTREES.ts:17-20` already passes `"staging"`. Add one test in `tests/mergeTaskWorktrees.test.ts` that runs the `--merge` CLI from a repo on the user's branch and expects the shared folder on `staging`.

6. The merge brief tells the user that merged work is on the `staging` branch in the `awaitingTesting` folder.
   WHY: `mergeWorktreeTasksBrief.ts:45-46` promises the work lands on the branch the user was on, and step 5 makes that false.
   HOW: `brief` is a template literal, so replace the sentence. Add one test in `tests/mergeWorktreeTasksBrief.test.ts` that checks the new sentence and that the old "the branch you were on" wording is gone. Add one `.replace()` in the byte-for-byte test so the pinned old wording maps onto the new one.

7. `npm run test:baseline` passes with no failure outside `.taskTools/knownFailingTests.json`.
   WHY: steps 2 to 6 each ran only their own test file.
   HOW: one agent runs the baseline once and fixes code, never tests.

8. A real tackle-tasks run in `~/Programming/relationship-mermaid` finishes without the wrong-branch throw.
   WHY: that repo holds the real broken folder from task 29, so it proves steps 3 and 4 on the case that failed.
   HOW: run `git -C ~/Programming/relationship-mermaid worktree list`. It shows `.../awaitingTesting [staging]` and no `.../staging` line. Paste the command and its output.

9. Goal: when a user launches a tackle-tasks run and their current branch has diverged from staging, the pipeline merges or fast-forwards staging in one shared checkout folder named awaitingTesting. That folder is always on the staging branch, never on the user's branch. If the folder is left in a broken state and holds no work, the pipeline repairs it on its own, and no run throws because of it.
