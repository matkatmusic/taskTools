# Phases 2–7 remediation feedback — iteration 1

Reviewed the staged remediation for `phase2-7-audit.md` only. The staged diff was frozen at SHA-256 `41376a454f47912505bf670ba3a26673e767a2179d9d9f0eb8c8c10028ec7c99`. `git diff --cached --check` and `npx tsc --noEmit` passed; the full suite passed all 1,694 tests. The following flagged requirements remain unresolved.

## F3 — make the task-state dirty exemption exact

The decision to ignore the root task-state files is correct: the active run necessarily changes `tasks.json` and may change `completedTasks.json`, so requiring a literally clean root would reject every real merge. The exemption must be limited to those two exact paths.

`mergeTaskWorktree.ts:isIgnorableStatusLine` also exempts an ancestor directory when an ignorable path begins with `path + "/"`. With ordinary porcelain output, an untracked `.taskTools/` directory can be collapsed to `?? .taskTools/`; that one line is then ignored even if the directory also contains unrelated files. This violates F3's requirement to refuse unrelated source dirt.

Required fix:

1. Read status with a NUL-safe form and `--untracked-files=all`, so every untracked file is reported separately and rename/path whitespace cannot affect parsing.
2. Normalize the two paths returned by `resolveTaskFiles(projectRoot)` relative to the root checkout.
3. Exempt only an exact status path equal to one of those two normalized paths. Do not exempt a parent directory, descendants, similarly named files, or either path in a submodule occurrence.
4. Preserve the existing source-tip receipt checks and dirty checks for every occurrence.

Proving tests:

- Allow a real merge when only the exact task-state file(s) are dirty.
- Put an unrelated untracked file beside them under `.taskTools/` and assert merge refuses before moving any source ref.
- Cover a whitespace path or rename with the NUL parser so the exact-path comparison cannot be bypassed by porcelain formatting.

## F7 — make absent-lease acquisition recoverable across the two durable writes

`acquireAbsentWorktreeLease` writes the physical lease and then `tasks.json`, with no intent record or rollback. If the task-state write throws or the process dies after the lease write, the physical lease names the current run while `task.run.leaseRunId` still names the old run. A retry can neither adopt it nor acquire it, so valid retained work becomes permanently non-resumable. Holding both guards prevents a concurrent writer but does not make the two filesystem writes atomic.

Required fix:

1. Add a durable acquisition intent, or generalize the existing lease-adoption intent, before the first authority changes. Record task number, worktree path, previous state owner, and new run ID.
2. Under task-state lock then lease guard, reconcile a surviving intent deterministically: if both authorities name the new run, delete the stale intent; if only the physical lease changed, either finish the fenced state write for the still-current run or restore the exact prior state/lease; never overwrite a different owner.
3. On an ordinary state-write failure, restore/remove the just-created physical lease before returning the error. Retain the intent if restoration fails.
4. Return `acquired: true` only after the physical lease and `leaseRunId` both name `expectedRunId` and the intent is gone.

Proving tests:

- Inject failure at the task-state write and assert no split lease/state ownership remains after rollback.
- Kill after the physical lease write, retry in a new process, and assert reconciliation reaches one consistent ownership state without losing the worktree.
- Preserve the existing different-owner refusal test.

## F11 — rollback worktree creation while ownership is still held

`createTaskWorktree` releases its lease before removing the worktree and branch. If lease release succeeds and removal fails, the journal survives but the retained worktree has no ownership marker. More seriously, the fault test changes the physical lease to another owner: release correctly refuses, but the code still calls `removeWorktreeAndBranch`, deleting a worktree after ownership proof was lost. The current test checks only the journal and therefore accepts this destructive path.

`createWorktreeForGroup` is also outside the rollback `try`; any failure there retains the journal without attempting the journal-defined, ownership-checked rollback.

Required fix:

1. Keep the lease until destructive rollback is complete. Under the lease guard, re-read the physical owner and proceed only if it still equals this `runId`.
2. Remove the exact journal worktree and task branch first, then release the exact owned lease last, then delete the journal.
3. If the physical owner differs, do not remove the worktree or branch and do not release the other owner's lease. Retain the journal and throw an aggregate/recovery error naming the mismatch.
4. Enclose `createWorktreeForGroup` and the state-recording step in the journal lifecycle. On either failure, attempt the same ownership-checked rollback; delete the journal only after complete rollback, otherwise retain it with the original error and rollback error.

Proving tests:

- When task-state recording fails, assert worktree, branch, lease, and journal are all absent after successful rollback.
- When removal fails, assert the lease still names this run and the journal retains exact recovery data.
- When the lease is changed to another owner before rollback, assert that owner's lease, the worktree, and branch are untouched and the journal remains.
- Inject failure inside `createWorktreeForGroup` after worktree creation and prove the same rollback/recovery contract.

## F12 — do not rewrite the durable archive on an archive-first retry

In the both-files case, `closeTaskRun` reuses only the archived note, then calls `closeTaskRunChecked`. That function re-derives hashes and calls `closeTasksLocked`, whose upsert replaces the entire completed record and writes a new completion date. The test passes only because its open and archived hashes happen to match, and it asserts two fields rather than the archived file bytes. F12 requires the already-written archive entry to remain byte-for-byte authoritative while only the open-record removal/unblocking is completed.

The completed-only mismatch path returns the same generic `skipped` result as “not found,” so it does not report the required ambiguity.

Required fix:

1. Move all four presence cases into one `withTaskStateLock` transaction that reads both task files once.
2. For both-files/same-run, validate that the archived note and hash array are well-formed and that the archive's run history contains the specified ended-completed run. Treat the archived record as immutable: remove/unblock the open task and write only `tasks.json`; do not call the completed-file upsert.
3. For only-open, retain the existing newest/inactive/ended/completed guard and derive chronological hashes from that run before the first archive write.
4. For only-completed, return success only for an exact run/note/hash reconciliation. Throw or return an explicitly distinguishable ambiguity result for mismatches; do not collapse it into not-found/skipped.
5. Keep caller-supplied commit arrays rejected.

Proving tests:

- Seed both files with deliberately different open-run hashes and an archived record containing extra durable fields; retry with a different note and assert `completedTasks.json` is byte-identical while the open task is removed and dependents are unblocked.
- Assert the completed-only mismatch names ambiguity distinctly from a task absent from both files.
- Preserve active, non-completed, stale-run, and successful idempotent-retry tests.

## M1 / F2 — finish the no-cwd contract for the guarded tail and recovery command

The new shared validator is the right approach, but `checkTaskFileFence` still accepts relative `projectRoot`/`worktreePath`, and `recoverSourceRepoLock` accepts a relative root. The recovery command emitted by `formatSourceRepoLockRecoveryCommand` invokes `node scripts/tackle-tasks/recoverSourceRepoLock.ts`, so the “exact recovery command” fails when an operator runs it outside the repository root. Its single-quoted JSON also breaks for a valid absolute path containing an apostrophe.

Required fix:

1. Apply `requireAbsolutePath` to both paths at the exported `checkTaskFileFence` boundary and to `projectRoot` before any recovery lock access.
2. Format the recovery command with the absolute `recoverSourceRepoLock.ts` path derived from `import.meta.url`.
3. Shell-quote both the stdin JSON and script path with a real POSIX single-quote escape helper, or emit an equivalent command that does not interpolate unescaped path data.
4. Keep the exact expected stale owner and confirmation string in the JSON payload.

Proving tests:

- Reject relative fence and recovery paths before Git/lock access.
- Execute the printed recovery command from an unrelated cwd and recover the intended cold lock.
- Repeat with a project path containing whitespace and an apostrophe; assert the exact intended owner is recovered and no other lock is touched.

## M4 — finish converting `checkTaskWorktreeSafe` Git tests to the required fixture

The shared layered fixture and new nested-uninitialized test are good. However, the wrong-branch and dirty-worktree tests in `checkTaskWorktreeSafe.test.ts` still build a standalone root with no submodule. The audit's M4 acceptance item requires every Git-touching Phase 2–7 test in these flagged suites to use a real submodule and real linked worktree; only the newly added F9 case currently does so. The resolver suite has been converted correctly.

Required fix:

1. Replace `makeTempRepoWithCommit` and the hand-built groups in the remaining safety tests with `makeLayeredSubmoduleFixture` plus `makeLinkedWorktree`.
2. Perform the wrong-branch and dirty-edit actions in that linked worktree and preserve their existing assertions.
3. Keep the non-Git invalid-directory test small; it does not need a repository fixture.

Proving test: the complete `checkTaskWorktreeSafe.test.ts` suite passes with no Git-touching case constructing a standalone repository or a worktree without a real submodule.
