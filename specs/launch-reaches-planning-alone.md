# A tackle-tasks launch reaches the planning stage on its own when staging is behind, a rebase has a conflict, a task file is outside the fence, or a listed file does not exist yet.

Word use: "the preamble" is the diagram `pipeline-preambleStatusCheck.mmd`. "The source-repo lock" is the lock in `scripts/tackle-tasks/shared/sourceRepoLock.ts` (`.git/taskTools-source.lock`). It is not the worktree lease and not the tasks.json lock. "The catch-up" is the move of `staging` to include the user's current branch, before the task worktree exists. "A resumed worktree" is a task worktree that an earlier, interrupted run left behind.
Not in this goal: the 2-try stop at `ARE_2_CONFLICT_FIXES_DONE_Q` for the rebase that runs after implementation. It stays as it is.
Rule: every new block uses the name and the `file:` path drawn in `plans/preamble-revised.mmd`. Step 13 is the one exception.

1. Start: five things stop a launch today. Catch-up conflict: `scripts/shared/prepareTasks.ts:271-274` throws. Resumed worktree, rebase conflict: `preambleStatusCheck/REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:68-77` goes to `ARE_2_CONFLICT_FIXES_DONE_Q`, which goes to `FAILURES_EXIT` after 2 tries. Resumed worktree, no notes file: `IS_PREVIOUS_RUN_RESUMABLE_Q.ts:11-21` goes to `FAILURES_EXIT`. File outside the fence: `DOES_FENCE_COVER_WORKTREE_Q.ts:19-26` goes to `FAILURES_EXIT`. Listed file missing: `INIT_SUBMODULES_RECURSIVELY.ts:22-30` goes to `FAILURES_EXIT`. The two diagram folders each hold a copy of the preamble.

2. All steps of `specs/diagrams-in-mermaid-viewer-format.md` are done.
   WHY: step 11 of that list installs `plans/preamble-revised.mmd` as the live preamble. The generator then writes a stub that throws for each of the 11 new blocks. Every block step below fills in one or more of those stubs. That list also settles how a decision script's `next` follows the diagram.

3. All steps of `specs/awaiting-testing-folder.md` are done.
   WHY: `CREATE_WORKTREE`, `RESET_WORKTREE`, and the merge tool still use the shared `awaitingTesting` folder after the catch-up. That folder must not throw.

4. The generator reads a `diagrams.json` file in each diagram folder to learn which diagram files belong to that folder.
   WHY: two folders can then name the same file, so a shared diagram exists one time only and cannot drift.
   HOW: `diagrams.json` is an array of paths relative to its folder. `getDiagramFileNames` (`generateSteps.ts:221-223`) reads the array. The `readdirSync` scan is commented out. A path that does not exist throws. One test: two folders name one shared file, and both get its blocks.

5. Every diagram that is byte-identical in `diagrams/tackle-tasks/` and `diagrams/tackle-tasks-fast/` lives one time in `diagrams/shared/`. The new preamble is one of them.
   WHY: the user does not want two copies of one file.
   HOW: `diff -rq diagrams/tackle-tasks diagrams/tackle-tasks-fast` finds the identical files. `git mv` each one to `diagrams/shared/`. `git rm` the fast copy. The fast folder's old preamble copy is removed, and its `diagrams.json` names the shared new preamble. Both `diagrams.json` files name the shared paths. The link list in `diagrams/tackle-tasks/index.html:39-66` points at the `../shared/` paths. The generator's dead-link guard lists each fast-folder node that still uses an old preamble block name. Rename each one. Run the generator for both folders.

6. A block that throws before a task worktree exists leaves the source-repo lock free.
   WHY: `buildFailure` returns early at `scripts/tackle-tasks/runStepHook.ts:282-285`. A throw in a catch-up block then holds the source-repo lock forever, and every later launch waits.
   HOW: release the lock inside `buildFailure` before the early return. One test: a block throws with the lock held, and the lock is free after.

7. One shared module holds the "merge the current branch into `staging`" code. `prepareTasks.ts` uses it. It returns a conflict and does not throw.
   WHY: the catch-up needs the same code as `resolveOrCreateStagingTip` (`prepareTasks.ts:229-281`). Two copies can drift. A returned conflict lets an agent fix it.
   HOW: move the body of `resolveOrCreateStagingTip` to a new file in `scripts/shared/`. Comment out the old body. The caller supplies the merge worktree path. `prepareTasks.ts` calls the module and throws on a returned conflict, so its two callers (`createWorktreeForGroup`, `ensureStagingWorktree`) see no change. The existing spawn matrix tests must pass with no edit.

8. `scripts/shared/catchUpStaging.ts` does the catch-up for the main repository and every submodule, and removes its merge worktree.
   WHY: a task can own files in a submodule, and each submodule has its own `staging`. The catch-up code stays out of `prepareTasks.ts`.
   HOW: it walks the submodules deepest first, then the root, like `resolveOrCreateStagingTipEverywhere` (`prepareTasks.ts:284-303`). It calls the module of step 7 with a merge worktree named `task-N-catchUpMerge`. Clean merge: it moves `staging`, then runs `git worktree remove --force` and `git worktree prune`. Conflict: it returns the repository, the worktree path, and the conflicted files, and it leaves the worktree in place for the agent. Tests: staging behind, staging diverged and clean, staging diverged with a conflict. Each clean case checks that the merge worktree is gone.

9. The preamble waits for the source-repo lock before the catch-up, with a deadline.
   WHY: `git branch -f staging` changes the source repository. Two launches must not do it at the same time. The source-repo lock already guards this class of change.
   HOW: fill in the stubs `LOCK_STAGING_FOR_CATCH_UP`, `WAS_CATCH_UP_LOCK_ACQUIRED_Q`, `HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q`, and `WAIT_FOR_CATCH_UP_LOCK`. Copy the four-block loop in `scripts/tackle-tasks/lockSourceRepo/`. It calls `acquireSourceRepoLock` with `buildLockOwner`. It uses the same lock file. The loop uses no agent turns. A passed deadline goes to `REPORT_ONLY_EXIT`.

10. The `CATCH_UP_STAGING` block does the catch-up while the source-repo lock is held.
    WHY: this is user note 1. It removes the throw when `staging` and the user's branch have moved apart.
    HOW: fill in the stub. It calls `catchUpStaging.ts`. YES (clean): release the lock, go to `MARK_TASK_ACTIVE`. NO (conflict): keep the lock, and put the repository, the worktree path, and the conflicted files in the payload. `MARK_TASK_ACTIVE.template.json` has `input.box` set to `IS_TASK_ACTIVE_Q` today. Set it to the block the diagram draws before it.

11. The `FIX_CATCH_UP_CONFLICTS` block returns a prompt, and a subagent fixes the conflicted files in the `task-N-catchUpMerge` worktree.
    WHY: this is user note 2. A conflict is work for an agent, not a reason to stop the launch.
    HOW: fill in the stub. The prompt is the same prompt that `FIX_CONFLICTS` returns near the end of the pipeline (`FIX_CONFLICTS.ts:26`, `fixConflictsPrompt` in `FixConflictsBodyEmitter.ts`). Only the worktree path and the file list differ.

12. The `COMMIT_CATCH_UP_MERGE` block commits the fixed merge, moves `staging`, and removes the merge worktree.
    WHY: the agent only edits files. A script must finish the merge so the result is checkable.
    HOW: fill in the stub. Reuse as much code as possible from the `COMMIT_..._IF_NEEDED` block scripts, first of all `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts` (its marker check is at `:16,30-32`). NO (conflict markers remain): go back to `FIX_CATCH_UP_CONFLICTS`. There is no try limit. YES: commit, move `staging`, remove the worktree, and go back to `CATCH_UP_STAGING`, which does the next repository or releases the lock.

13. The block `IS_PREVIOUS_RUN_RESUMABLE_Q` becomes two blocks: `B_RESUME_PREVIOUS_RUN_IF_POSSIBLE`, then `Q_PREVIOUS_RUN_LEFT_NOTES`. Both answers go to `REBASE_RESUMED_WORKTREE_ONTO_STAGING`.
    WHY: the old block does two jobs under a question name. It adopts the worktree lease, and it looks for a notes file. A resumed worktree with no notes file is not a failure, so the `FAILURES_EXIT` arrow goes away.
    HOW: edit the live preamble diagram only, and run the generator. `B_RESUME_PREVIOUS_RUN_IF_POSSIBLE` adopts the lease (`isTaskRunResumable.ts:40-41`). `Q_PREVIOUS_RUN_LEFT_NOTES` finds the notes file (`isTaskRunResumable.ts:44-54`). Its `Q_CHOICE` nodes read "YES<br/>passes the notes file path" and "NO<br/>passes an empty path". Split the old script file into the two new script files: the lease code goes to the first, the notes-file code goes to the second. The `FAILURES_EXIT` result at `IS_PREVIOUS_RUN_RESUMABLE_Q.ts:11-21` goes to neither. The old file is then fully replaced, so `git rm` it and its template. The generator's orphan guard throws if it remains.

14. The `FIX_RESUMED_REBASE_CONFLICTS` block returns a prompt, and a subagent fixes the conflicted files in the resumed worktree.
    WHY: an earlier run left the worktree, and another task moved `staging` since then. The rebase onto the new `staging` can have a conflict. Today that goes to the 2-try stop.
    HOW: fill in the stub. Reuse as much code as possible from the scripts of the later block that fixes merge conflicts (`FIX_CONFLICTS.ts` and `fixConflictsPrompt`). `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:68-77` sends NO to this block, not to `ARE_2_CONFLICT_FIXES_DONE_Q`. It keeps the source-repo lock.

15. The `CONTINUE_RESUMED_REBASE` block commits the fix and continues the rebase.
    WHY: a rebase has many layers, and each layer can have a conflict.
    HOW: fill in the stub. Reuse as much code as possible from the `COMMIT_..._IF_NEEDED` block scripts, as in step 12: the marker check from `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts:16,30-32`, `advanceTaskRebase` from `CONTINUE_REBASE.ts:18-26`, and the lock release from `IS_REBASE_FINISHED_Q.ts:15-25`. NO (next layer has a conflict): keep the lock, go back to `FIX_RESUMED_REBASE_CONFLICTS`. There is no try limit. YES (rebase finished): release the lock, go to `DOES_FENCE_COVER_WORKTREE_Q`.

16. The `AMEND_TASK_FILE_LIST` block adds every outside-the-fence file to the task's file list in tasks.json, and the run continues.
    WHY: this is user note 3. The fence check runs only on a resumed worktree. It fails when the earlier run edited a file that the task does not list (`checkResumedWorktreeFence.ts:33-66`). The work is real, so the record is what is wrong.
    HOW: fill in the stub. It calls `addTaskFiles` with the files that `DOES_FENCE_COVER_WORKTREE_Q` put in the payload.

17. A listed file that does not exist no longer stops the launch. The task's `createsFiles` list gains the file, and the run continues to `DOCUMENT_GENERATION`.
    WHY: this is user note 4. A missing file means the task creates it. The code names the list `createsFiles`.
    HOW: fill in the stub `ADD_MISSING_FILES_TO_CREATES_FILES`. New `addTaskCreatesFiles.ts`. It moves each missing path out of `modifiableFiles` and into `createsFiles`, under the tasks.json lock.

18. `tests/tackleTasksAcceptance.test.ts` walks the new preamble.
    WHY: every test in this file starts at `PREAMBLE_STATUS_CHECK` and follows `next`, so the new blocks change every walk.
    HOW: the 12 existing tests pass. Add one test for each behavior. (a) `staging` diverged and clean: the walk reaches the first block of `pipeline-planTheTask.mmd`. (b) catch-up conflict: the walk stops at the `FIX_CATCH_UP_CONFLICTS` prompt, and after a fix it reaches planning with the source-repo lock free. (c) resumed worktree with a rebase conflict: the walk stops at the `FIX_RESUMED_REBASE_CONFLICTS` prompt, and after a fix it reaches planning. (d) resumed worktree with no notes file: the walk passes `Q_PREVIOUS_RUN_LEFT_NOTES` on NO and reaches planning. (e) resumed worktree with a stray edit: tasks.json gains the file, and the walk reaches planning. (f) listed file missing: `createsFiles` gains the file, and the walk reaches planning. (g) another owner holds the source-repo lock past the deadline: the walk ends at `REPORT_ONLY_EXIT`.

19. `npm run test:baseline` passes with no failure outside `.taskTools/knownFailingTests.json`.
    WHY: each step above ran only its own tests.
    HOW: one agent runs the baseline once and fixes code, never tests.

20. A script builds a fresh fixture repo in a temp folder with four tasks, and sets up the state for one case at a time.
    WHY: the four stops are hard to produce by hand, and a fresh build makes each proof run repeatable.
    HOW: `bun tests/support/buildPreambleProofRepo.ts build` makes a repo with no submodule: branch `main`, branch `staging`, files `a.txt` to `d.txt`, and `.taskTools/tasks.json`. Each entry has the fields of the fixture at `tests/tackleTasksAcceptance.test.ts:49-62`. Task 1 edits `a.txt`. Task 2 edits `b.txt` and is blocked by 1. Task 3 edits `c.txt` and is blocked by 2. Task 4 lists `modifiableFiles: ["d.txt", "e.txt"]`, where `e.txt` does not exist, and is blocked by 3. Each task adds one line to its file, so each run finishes and unblocks the next. `prepare 1`: one new commit on `main` only, so `staging` is behind. `prepare 2`: one commit on `main` and one on `staging` that change the same line of `z.txt`. `prepare 3`: the script fakes a resumed worktree: the task-3 worktree, its lease, an ended run record with a notes file, and one uncommitted edit to `stray.txt`. `prepare 4`: nothing, because `e.txt` is already missing. The script prints the repo path.

21. Four real tackle-tasks launches in the fixture repo, one per case, each reach the planning stage.
    WHY: tests drive blocks with no real agent. Only a real launch proves the whole preamble.
    HOW: for N = 1 to 4: run `prepare N`, then launch `/tackle-tasks N` in the fixture repo. Paste `.taskTools/runs/<stamp>/task-N-run-log.json`. It must list a `pipeline-planTheTask.mmd` block and no `FAILURES_EXIT` block. Run 2 must list `FIX_CATCH_UP_CONFLICTS`. Run 3 must list `AMEND_TASK_FILE_LIST`, and tasks.json must list `stray.txt`. Run 4 must list `ADD_MISSING_FILES_TO_CREATES_FILES`, and `createsFiles` must hold `e.txt`.

22. Goal: a tackle-tasks launch reaches the planning stage on its own when staging is behind, a rebase has a conflict, a task file is outside the fence, or a listed file does not exist yet.
