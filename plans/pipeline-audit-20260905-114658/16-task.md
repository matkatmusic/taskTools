# Task 16 plan — cleanup loses its resume cursor; rebase never releases the source lock on crash

Session task 16 (`/Users/matkatmusicllc/.claude/tasks/taskTools-86/16.json`), blocked by task 15.
Spec, two independent fixes:

1. **Cleanup resume cursor.** `cleanupTaskWorktree.ts:82-91` (via `mergeTaskWorktrees.ts`'s
   `collectRetainedTaskArtifacts`) *correctly* keeps the worktree lease when cleanup leaves
   artifacts behind — `cleanupTaskWorktree.test.ts:80-100` already asserts this and it must not
   change. The real bug: once `CLEAN_UP_WORKTREES` has started deleting the worktree, the worktree
   (and the `plans/checkpoint.json` inside it) can vanish mid-cleanup; `resumeRun.ts`'s
   `usableWorktree` check then goes false, and (after task 15's fix) row 3 always resumes at
   `BUILD_CLOSURE_NOTE` — skipping a retry of `CLEAN_UP_WORKTREES` forever, even though artifacts
   (a branch ref, a merge-intent ref, the lease itself) may still be sitting there. Fix: persist
   cleanup progress **outside** the disposable worktree (in `tasks.json`, via `taskRunState.ts`,
   which already survives worktree deletion) and make resume retry `CLEAN_UP_WORKTREES` from that
   record until it fully finishes.
2. **Rebase lock leak.** `rebaseTaskWorktree.ts` throws at lines 149 and 167 (inside
   `mapSubmoduleStop`/`mapParentOutcome`) with no call to `releaseSourceRepoLock` anywhere on that
   path, after the source-repo lock was acquired a few lines earlier. Fix: release the lock on
   every exceptional exit after acquisition; the deliberate "conflicted" outcome (a normal return,
   not a throw) must keep the lock held, since `FIX_CONFLICTS` needs it.

Per the orchestrating plan's instruction, this plan owns the **one** persisted cursor record both
this task and task 23 need — its shape, its file location, and the functions that read/write it.
Task 23 reuses it verbatim for the failures-exit chain; it must not invent a second record.

## Scope confirmation

- `scripts/tackle-tasks/shared/taskRunState.ts` — read in full (711 lines). `TaskRunRecord` (lines
  60-80) today ends:
  ```ts
      stepResults?: StepResultReceipt[];
      // A repair flag, not an exit type: work landed but the run could not finish cleanly.
      cleanupIncomplete?: boolean;
      // Persisted retry counters, keyed by name. Absent counter reads as zero.
      attempts?: Record<string, number>;
      // Hook passIds already counted per counter, so a re-run of the same block counts once.
      countedPasses?: Record<string, string[]>;
  };
  ```
  `cleanupIncomplete` is a different, already-wired mechanism (set by
  `scripts/tackle-tasks/failuresExit/WRITE_PUBLICATION_OUTCOME.ts:15` and consumed only by
  `scripts/runMergePhase.ts`'s orchestrator-level "cleanup-only" retry stage, confirmed via
  `grep -rn cleanupIncomplete`); it is not touched by this task and is not the mechanism this task
  adds. `appendStepResult` (lines 527-553) is the model for the new function: it mutates the newest
  history record keyed only by matching `runId`, with **no** `state.active` check (unlike
  `updateCurrentTaskRun`, which throws `"no active run for task X"` at line 508 whenever
  `!state.active`). That distinction matters: `MARK_TASK_INACTIVE_SUCCESS` runs before
  `CLEAN_UP_WORKTREES`... no — checked the real order in `scripts/steps.json`'s
  `pipeline-mergeSucceededExit.mmd` array: `CLEAN_UP_WORKTREES` runs *before*
  `MARK_TASK_INACTIVE_SUCCESS`, so the run is still active while `CLEAN_UP_WORKTREES` is retried by
  this task. It is task 23's failures-exit chain (`MARK_TASK_INACTIVE_FAILURE` runs mid-chain,
  before `DOES_RUN_HOLD_LEASE_Q`/`RELEASE_WORKTREE_LEASE`/`DOES_RUN_HOLD_SOURCE_LOCK_Q`/
  `RELEASE_SOURCE_LOCK`/`REPORT_EXIT_TYPE_AND_NOTE`, per that same file's `pipeline-failuresExit.mmd`
  array) that needs to write this new cursor on an already-inactive run — which is exactly why the
  new function must not gate on `state.active`, and why this plan (not task 23) is the one that
  must get that gate right from the start.
- `scripts/tackle-tasks/shared/resumeRun.ts` — same file task 15 edits; this task adds a new
  earlier-priority check. Current lines 13-20 (after task 15's step 2 lands):
  ```ts
  export function findResumeEntry(taskNumber: number, tasksFile: string): { block: string; input: string } | null {
      const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
      if (!isTaskNumberValid(taskNumber, projectRoot).valid) return null; // row 1

      const state = readTaskRunState(taskNumber, projectRoot);
      const newest = state.history[state.history.length - 1] ?? null;
      const worktree = state.worktree;
      const usableWorktree = worktree !== null && existsSync(worktree) && existsSync(checkpointPath(worktree));
  ```
  This plan inserts a new "row 0" between `newest` being computed and the `usableWorktree` check,
  so a live tail cursor always outranks the worktree checkpoint — required because task 23's
  failures-exit chain leaves the worktree and its (now stale) checkpoint alive throughout the tail;
  a stale checkpoint must never win over a cursor that names where the tail actually stopped.
- `scripts/tackle-tasks/shared/resumeRun.test.ts` — same file task 15 edits; this task adds two new
  tests after task 15's replaced test, using the file's existing `makeSourceRepoWithSubmodule`,
  `createLinkedWorktree`, `seedTaskAndClaim`, `baseCheckpoint` helpers (all already read in task
  15's research) and `writeCheckpoint` (imported at line 9).
- `scripts/tackle-tasks/mergeSucceededExit/CLEAN_UP_WORKTREES.ts` — read in full (30 lines):
  ```ts
  export function main(input: string): Record<string, unknown> {
      const packet = JSON.parse(input) as CleanUpWorktreesInput;
      cleanupTaskWorktree({
          projectRoot: packet.projectRoot, worktreePath: packet.worktree, taskNumber: packet.taskNumber, runId: packet.runId,
          rootSourceBranch: "staging",
      });
      return {
          box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
          projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
      };
  }
  ```
  This is the one caller this task instruments: it writes the cursor pointing at itself before the
  risky call, and clears it only once `cleanupTaskWorktree` returns with `retainedArtifacts.length
  === 0` — matching the audit's literal wording, "release the lease only when
  `collectRetainedTaskArtifacts()` is empty" (`cleanupTaskWorktree`'s own return value already
  recomputes and reports that array, per `scripts/tackle-tasks/shared/cleanupTaskWorktree.ts:98`).
  `cleanupTaskWorktree` itself needs **no** change: its lease-retention behavior at lines 82-91 is
  already correct and already asserted by `cleanupTaskWorktree.test.ts:80-100`
  (`test_cleanupTaskWorktree_keepsTheLeaseWhenWorktreeRemovalFails`), confirmed still present and
  unedited at those exact lines. `cleanupTaskWorktree`'s idempotency on a second full call (the
  worktree already gone) is already asserted by
  `test_cleanupTaskWorktree_succeedsWhenRunTwice` (lines 103-117), which this task's retry loop
  relies on.
  One gap a plain retry loop does not close on its own: `cleanupTaskWorktree`'s catch block (lines
  82-85) always calls `releaseSourceRepoLock(input.projectRoot, owner)` when the removal itself
  throws, even though cleanup did not finish — confirmed live. Its gate before that try block is
  `refreshOwnedSourceRepoLockOrThrow(input.projectRoot, owner)` (line 73), and
  `refreshSourceRepoLock` (`sourceRepoLock.ts:161-174`) only rewrites the heartbeat of a lock that
  is already held by `owner`; it never acquires an absent one. So a bare replay of the same input
  after a throw hits `refreshOwnedSourceRepoLockOrThrow` again with the lock now gone and throws
  `"source repository lock is no longer owned by..."` before `cleanupTaskWorktree` does any work —
  the retry cannot succeed unless something reacquires the lock first. `cleanupTaskWorktree.test.ts`'s
  own `test_cleanupTaskWorktree_aNewRunAdoptsTheRetainedLeaseAfterCleanupFailure` (lines 136-176)
  already demonstrates the fix pattern this repo uses for exactly this situation: the caller calls
  `acquireSourceRepoLock` again before retrying, not `cleanupTaskWorktree` itself. `resumeRun.ts`'s
  own `prepareResume` (lines 62-66) uses the identical "acquired or already-held-by-me, else throw"
  shape for the same reason. Step 3 below makes `CLEAN_UP_WORKTREES.ts` — the caller — do this
  before every attempt, matching both precedents, rather than changing `cleanupTaskWorktree.ts`.
- `scripts/tackle-tasks/mergeSucceededExit/CLEAN_UP_WORKTREES.test.ts` — read in full (84 lines).
  None of its three existing tests seed a `tasks.json` task record; they call
  `createWorktreeForGroup` directly. Once `main()` writes the tail cursor via
  `writeTailCursor(taskNumber, runId, ..., projectRoot)`, that call requires a task record to exist
  at `resolveTaskFiles(rootOrigin)` naming `taskNumber` with a matching `runId` in its history, or it
  throws `"task N not found"` before `cleanupTaskWorktree` ever runs. All three existing tests must
  therefore seed and claim a task first, using the same `seedTaskAndClaim` shape already proven in
  `scripts/tackle-tasks/shared/resumeRun.test.ts:58-64` (this repo already has this exact pattern
  duplicated across test files; adding one more instance here matches existing convention rather
  than inventing a shared helper for a still-small number of call sites).
- `scripts/tackle-tasks/shared/rebaseTaskWorktree.ts` — read in full (229 lines). Lines 170-219,
  the whole exported `rebaseTaskWorktree` function body from `refreshOwnedSourceRepoLockOrThrow`
  (line 188) onward, is not wrapped in any `try`/`catch`. `mapSubmoduleStop` (lines 137-150) throws
  at line 149 for the `default` branch (`cleanup-failed`, `source-sync-failed`, or an
  unresolved-test-policy `submodule` outcome); `mapParentOutcome` (lines 152-168) throws at line 167
  for its `default` branch. Since `rebaseTaskWorktree` always calls
  `rebaseParentOntoSourceAndTest(..., runTests=false)` (confirmed at line 209: the last argument is
  literally `false`), and `rebaseParentOntoSourceAndTest`'s own body (`scripts/mergeTaskWorktrees.ts:404-407`)
  returns `{status: "rebased"}` immediately whenever `!runTests`, the only reachable throw from
  `mapParentOutcome` in this file is via `outcome.status === "cleanup-failed"` — never `"untested"`
  or `"tests-failed"`, which are unreachable with tests disabled. `releaseSourceRepoLock` (imported
  already? **not** imported today — only `acquireSourceRepoLock, buildLockOwner,
  refreshOwnedSourceRepoLockOrThrow` are imported at lines 4-6) reproves ownership itself before
  unlinking (`scripts/tackle-tasks/shared/sourceRepoLock.ts:187-193`: `if (existing === null ||
  existing.owner !== owner) return { released: false };`), so calling it unconditionally in a catch
  block is always safe, matching the existing precedent at
  `scripts/tackle-tasks/shared/cleanupTaskWorktree.ts:82-91`, which already does exactly this
  (catches a cleanup failure, calls `releaseSourceRepoLock` unconditionally, then rethrows).
  `scripts/tackle-tasks/rebase/REBASE_ONTO_TARGET_BRANCH.ts` (the only production caller, confirmed
  via `grep -rn "rebaseTaskWorktree("`) has no `try`/`catch` of its own around its `await
  rebaseTaskWorktree(...)` call at line 29, so a throw here propagates all the way to an unhandled
  promise rejection / non-zero process exit, exactly the "hard failure" `runStepHook.ts`'s
  `buildFailure` currently absorbs. Task 195 (`.taskTools/tasks.json` id 195, read in full) will add
  a **second** call site to this same `rebaseTaskWorktree` function from a new preamble box; fixing
  the shared function (not each call site) means that second site inherits the same lock-release
  guarantee automatically once task 195 lands — no action needed here beyond noting it.
- `scripts/tackle-tasks/shared/rebaseTaskWorktree.test.ts` — read in full (through line 70; the
  file continues with 5 more tests per `grep -n "test("`). No existing test drives the throwing
  branch. This task adds one. The file already imports `claimTask` (line 11) and has a working
  `seedTaskAndClaim` helper (lines 53-59) and `makeSourceRepoWithSubmodule` /
  `createLinkedWorktree` helpers (lines 37-51) to reuse as-is.
  `tests/mergeTaskWorktrees.test.ts:815-854` (`test_rebaseGroupOntoSource...`, read for its exact
  git-shim technique) is the proven way to force `rebaseGroupOntoSource` into `"cleanup-failed"`:
  create a real conflicting edit between the worktree branch and the source branch so a rebase
  conflict occurs, then shim `git` on `PATH` so `-C <path> rebase --abort` (the cleanup path's own
  abort attempt) fails, which makes `rebaseGroupOntoSource` (and therefore
  `rebaseParentOntoSourceAndTest` and `mapParentOutcome`) return/throw `"cleanup-failed"`.

## Steps

### Step 1 — `TaskRunRecord.tailCursor` and `writeTailCursor` (RED, then GREEN)

Test name: `test_writeTailCursor_persistsRegardlessOfActiveStateAndCanBeCleared`, added to
`scripts/tackle-tasks/shared/taskRunState.test.ts` near the other single-behavior tests
(after the `raiseAttemptCount`/`resetAttemptCounts` block, e.g. after line 1039's
`test_resetAttemptCounts_refusesARunIdThatIsNotTheNewest`, matching that file's existing
one-behavior-per-test granularity — write three small tests, not one:

```ts
test("test_writeTailCursor_persistsAndReadsBackWhileTheRunIsActive", () => {
    // Setup: a task with an active run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: write a tail cursor naming an arbitrary block and input.
    writeTailCursor(1, "run-a", { block: "pipeline-failuresExit.mmd::RELEASE_SOURCE_LOCK", input: "{}" }, root);
    // Verification: it reads back unchanged from the run's history.
    const state = readTaskRunState(1, root);
    assert.deepEqual(state.history[0].tailCursor, { block: "pipeline-failuresExit.mmd::RELEASE_SOURCE_LOCK", input: "{}" });
});

test("test_writeTailCursor_persistsAfterTheRunHasEnded", () => {
    // Setup: a task whose run has already ended (unlike updateCurrentTaskRun, this must not require active).
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    endTaskRun(1, "run-a", root);
    // Test action: write a tail cursor against the now-inactive run.
    writeTailCursor(1, "run-a", { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input: "{}" }, root);
    // Verification: it persists even though the run is inactive.
    const state = readTaskRunState(1, root);
    assert.equal(state.active, false);
    assert.deepEqual(state.history[0].tailCursor, { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input: "{}" });
});

test("test_writeTailCursor_clearsWithNull", () => {
    // Setup: a task with a tail cursor already set.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    writeTailCursor(1, "run-a", { block: "x.mmd::X", input: "{}" }, root);
    // Test action: clear it by writing null.
    writeTailCursor(1, "run-a", null, root);
    // Verification: the field reads back null.
    assert.equal(readTaskRunState(1, root).history[0].tailCursor, null);
});
```
Add `writeTailCursor` to the existing `taskRunState.ts` import block at the top of the test file.

These fail (RED) because `writeTailCursor` does not exist yet.

Production change in `scripts/tackle-tasks/shared/taskRunState.ts`:
1. In the `TaskRunRecord` type (lines 60-80), after line 75 (`cleanupIncomplete?: boolean;`), add:
   ```ts
       // Where an exit-tail resume must continue when the worktree's own checkpoint cannot be
       // trusted (the worktree is gone, or the tail has frozen checkpoint-writing): the exact
       // block+input to hand back to the walk. Null once that tail box fully finishes. Owned by
       // writeTailCursor below; read by resumeRun.ts's findResumeEntry.
       tailCursor?: { block: string; input: string } | null;
   ```
2. After `appendStepResult` (ends at line 553) and before `getAttemptCount` (line 556), add:
   ```ts
   // F-tail: persists where an exit-tail resume must continue. Unlike updateCurrentTaskRun, this
   // never checks state.active — a failures-exit box can need to write this after the run has
   // already been marked inactive.
   export function writeTailCursor(
       taskNumber: number,
       expectedRunId: string,
       cursor: { block: string; input: string } | null,
       projectRoot: string,
   ): TaskRunState {
       const { tasksPath } = resolveTaskFiles(projectRoot);
       return withTaskStateLock(tasksPath, () => {
           const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
           const task = findTask(tasks, taskNumber);
           if (task === undefined) throw new Error(`task ${taskNumber} not found`);
           const state = getRunState(task);
           const newest = state.history[state.history.length - 1];
           if (newest === undefined || newest.runId !== expectedRunId) {
               throw new Error(`task ${taskNumber}'s newest run is not "${expectedRunId}"`);
           }
           const nextRecord: TaskRunRecord = { ...newest, tailCursor: cursor };
           const nextState: TaskRunState = { ...state, history: [...state.history.slice(0, -1), nextRecord] };
           task.run = nextState;
           writeJsonAtomically(tasksPath, tasks);
           return nextState;
       });
   }
   ```

Run `npm test -- scripts/tackle-tasks/shared/taskRunState.test.ts`: the three new tests pass.

### Step 2 — `findResumeEntry` gives the tail cursor priority over the worktree checkpoint (RED, then GREEN)

Add to `scripts/tackle-tasks/shared/resumeRun.test.ts`, after the test added by task 15 (or after
`test_findResumeEntry_resumesTheMergeTailAtBuildClosureNoteWhileActive`, either position is fine —
keep the file's existing top-to-bottom "one findResumeEntry behavior at a time" ordering):

```ts
test("test_findResumeEntry_resumesAtTheTailCursorRegardlessOfExitTypeOrActiveState", () => {
    // Setup: a claimed, still-active run with no completed exitType at all.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9217;
    const runId = "run-9217";
    seedTaskAndClaim(rootOrigin, taskNumber, "tail cursor wins", runId, []);
    const cursor = { block: "pipeline-failuresExit.mmd::RELEASE_SOURCE_LOCK", input: JSON.stringify({ taskNumber, runId }) };
    writeTailCursor(taskNumber, runId, cursor, rootOrigin);

    // Test action: resume the task.
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);

    // Verification: the tail cursor is returned verbatim, bypassing rows 2-5 entirely.
    assert.deepEqual(entry, cursor);
});

test("test_findResumeEntry_prefersTheTailCursorOverAnExistingUsableCheckpoint", () => {
    // Setup: a claimed run with BOTH a live worktree checkpoint AND a tail cursor.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9218;
    const runId = "run-9218";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "tail cursor beats checkpoint", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    writeCheckpoint(worktreePath, baseCheckpoint(taskNumber, runId, rootOrigin));
    const cursor = { block: "pipeline-failuresExit.mmd::REPORT_EXIT_TYPE_AND_NOTE", input: JSON.stringify({ taskNumber, runId }) };
    writeTailCursor(taskNumber, runId, cursor, rootOrigin);

    // Test action: resume the task.
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);

    // Verification: the tail cursor wins even though a usable checkpoint also exists — this is
    // the exact ordering task 23's failures-exit chain depends on, since that chain leaves a
    // stale checkpoint alive throughout the tail.
    assert.deepEqual(entry, cursor);
});
```
Add `writeTailCursor` to the existing `taskRunState.ts` import list at the top of the file
(alongside `readTaskRunState, reopenTaskRun, endTaskRun, claimTask, updateCurrentTaskRun`).

Both fail (RED): `findResumeEntry` does not read `tailCursor` yet, so it falls through to rows
2-5 and returns something else (row 2's checkpoint, or `null`).

Production change in `scripts/tackle-tasks/shared/resumeRun.ts`: insert a new row 0 between the
`newest` computation and the `usableWorktree` check (i.e. between the current lines 18 and 19):
```ts
    const newest = state.history[state.history.length - 1] ?? null;
    if (newest !== null && newest.tailCursor) { // row 0: an exit-tail cursor always outranks the worktree checkpoint
        return { block: newest.tailCursor.block, input: newest.tailCursor.input };
    }
    const worktree = state.worktree;
```
No call to `prepareResume`/`markCheckpointResumed` here: every box a tail cursor can point at
(`CLEAN_UP_WORKTREES`, and every box task 23 instruments in the failures-exit chain) either
re-derives lock/lease ownership itself (`cleanupTaskWorktree`'s own
`refreshOwnedSourceRepoLockOrThrow`) or only reads/releases lock and lease state that a crash
cannot un-acquire — unlike the row 2 checkpoint path, which resumes into arbitrary task-work boxes
that assume `prepareResume`'s reopening semantics.

Run `npm test -- scripts/tackle-tasks/shared/resumeRun.test.ts`: both new tests pass, and every
test added by task 15 and every pre-existing test in the file still passes (none of them ever set
`tailCursor`, so `newest.tailCursor` is `undefined` and row 0 is a no-op for them).

### Step 3 — `CLEAN_UP_WORKTREES` writes the cursor before cleaning up, clears it once truly empty

First, update the three existing tests in
`scripts/tackle-tasks/mergeSucceededExit/CLEAN_UP_WORKTREES.test.ts` so they keep passing once
`main()` requires a task record to exist (they will otherwise start throwing `"task N not found"`
before ever reaching `cleanupTaskWorktree`, for a reason unrelated to what each test itself
verifies):
1. Add imports: `import { claimTask, readTaskRunState } from "../shared/taskRunState.ts";`,
   `import { resolveTaskFiles } from "../../taskFiles.ts";`, `import { writeJsonAtomically } from
   "../../taskStateLock.ts";`, and `mkdirSync, dirname` alongside the existing `node:fs`/`node:path`
   imports.
2. Add a helper, mirroring `scripts/tackle-tasks/shared/resumeRun.test.ts:58-64`:
   ```ts
   function seedTaskAndClaim(rootOrigin: string, taskNumber: number, runId: string): void {
       const { tasksPath } = resolveTaskFiles(rootOrigin);
       mkdirSync(dirname(tasksPath), { recursive: true });
       writeJsonAtomically(tasksPath, [{ taskNumber, title: "t" }]);
       const outcome = claimTask(taskNumber, runId, rootOrigin);
       assert.equal(outcome.status, "claimed");
   }
   ```
3. In each of the three existing tests (`test_CLEAN_UP_WORKTREES_leavesEverySourceCheckoutClean`,
   `test_CLEAN_UP_WORKTREES_runsTwiceWithTheSameInput`,
   `test_CLEAN_UP_WORKTREES_refusesAndMutatesNothingWhenTheSourceLockIsOwnedByAnotherRun`), call
   `seedTaskAndClaim(rootOrigin, taskNumber, runId);` right after `createLinkedWorktree(...)`,
   before `acquireSourceRepoLock(...)`.

Then add two new tests (test-first):

`test_CLEAN_UP_WORKTREES_clearsTheTailCursorOnceFullyClean`:
```ts
test("test_CLEAN_UP_WORKTREES_clearsTheTailCursorOnceFullyClean", () => {
    // Setup: a claimed task with a linked worktree and the source lock held.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-60";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");

    // Test action: run CLEAN_UP_WORKTREES to full success.
    main(JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath)));

    // Verification: no tail cursor is left once cleanup is verifiably complete.
    const state = readTaskRunState(taskNumber, rootOrigin);
    assert.equal(state.history[0].tailCursor, null);
});
```

`test_CLEAN_UP_WORKTREES_leavesTheTailCursorOnAThrowAndTheRetrySucceeds`:
```ts
test("test_CLEAN_UP_WORKTREES_leavesTheTailCursorOnAThrowAndTheRetrySucceeds", () => {
    // Setup: a claimed task with a linked worktree, the source lock held, and worktree removal
    // rigged to fail (git worktree lock, the same technique cleanupTaskWorktree.test.ts uses).
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-61";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");
    git(rootOrigin, "worktree", "lock", worktreePath, "--reason", "test");
    const input = JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath));

    // Test action: the first attempt throws (removal is locked). cleanupTaskWorktree's own catch
    // releases the source lock even though cleanup did not finish (its existing, correct behavior).
    assert.throws(() => main(input));

    // Verification: the tail cursor survives the throw, naming this exact box and input.
    const afterThrow = readTaskRunState(taskNumber, rootOrigin);
    assert.deepEqual(afterThrow.history[0].tailCursor, {
        block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input,
    });
    assert.equal(readSourceRepoLock(rootOrigin), null);

    // Test action: unlock, then retry with the exact cursor input (what resumeRun.ts would replay).
    // No manual re-acquire here: main() itself must reacquire the now-absent lock before retrying.
    git(rootOrigin, "worktree", "unlock", worktreePath);
    main(afterThrow.history[0].tailCursor!.input);

    // Verification: the retry finishes cleanup and clears the cursor.
    const afterRetry = readTaskRunState(taskNumber, rootOrigin);
    assert.equal(afterRetry.history[0].tailCursor, null);
    assert.equal(existsSync(worktreePath), false);
});
```
(`existsSync` is already imported in this file at line 4; add `readSourceRepoLock` to the existing
`sourceRepoLock.ts` import.)

`test_CLEAN_UP_WORKTREES_resumeReplaysAfterTheWrapperDiesBetweenCleanupSucceedingAndClearingTheCursor`:
the throw-during-removal test above exercises a crash *before* the worktree is gone; the audit's
MSE-12 finding is specifically about a crash *after* the worktree is already deleted (cleanup fully
succeeded) but before `main()` clears the cursor — a distinct window, worth its own test:
```ts
test("test_CLEAN_UP_WORKTREES_resumeReplaysAfterTheWrapperDiesBetweenCleanupSucceedingAndClearingTheCursor", () => {
    // Setup: a claimed task with a linked worktree and the source lock held; the cursor is written
    // exactly like main()'s first line would, simulating that CLEAN_UP_WORKTREES already started.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-62";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");
    const input = JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath));
    writeTailCursor(taskNumber, runId, { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input }, rootOrigin);

    // Test action: cleanupTaskWorktree runs to full completion directly — as if main() had called
    // it and the process died right after, before main() could clear the cursor. The worktree and
    // its checkpoint are gone, but the durable cursor (in tasks.json, outside the worktree) survives.
    const result = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId, rootSourceBranch: "staging" });
    assert.equal(result.removed, true);
    assert.equal(existsSync(worktreePath), false);
    assert.deepEqual(readTaskRunState(taskNumber, rootOrigin).history[0].tailCursor, {
        block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input,
    });

    // Test action: resume finds the cursor (the worktree checkpoint is gone, so row 2 cannot fire)
    // and replays CLEAN_UP_WORKTREES with its exact input.
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);
    assert.deepEqual(entry, { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input });
    main(entry!.input);

    // Verification: the replay is a no-op cleanup (cleanupTaskWorktree's own F2 early return, and
    // test_cleanupTaskWorktree_succeedsWhenRunTwice already proves this is safe) that reacquires
    // the lock this run needs, finds nothing left to do, and clears the cursor.
    assert.equal(readTaskRunState(taskNumber, rootOrigin).history[0].tailCursor, null);
});
```
Add imports for this test: `findResumeEntry` from `../shared/resumeRun.ts` and `resolveTaskFiles`
from `../../taskFiles.ts` (the latter may already be needed by the `seedTaskAndClaim` helper added
above).

All three fail (RED): `main()` does not write or clear any `tailCursor` yet, and cannot reacquire a
lock it dropped on a prior throw.

Production change in `scripts/tackle-tasks/mergeSucceededExit/CLEAN_UP_WORKTREES.ts`:
```ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { cleanupTaskWorktree } from "../shared/cleanupTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, releaseSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { writeTailCursor } from "../shared/taskRunState.ts";

export type CleanUpWorktreesInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktree: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CleanUpWorktreesInput;
    const owner = buildLockOwner(packet.runId, packet.taskNumber);
    writeTailCursor(
        packet.taskNumber, packet.runId,
        { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input },
        packet.projectRoot,
    );
    // A prior failed attempt's catch (cleanupTaskWorktree.ts:82-85) always releases this lock even
    // though cleanup did not finish, so a retry must be able to reacquire it, not merely refresh it
    // (the same "acquired or already-held-by-me, else throw" shape resumeRun.ts's prepareResume uses).
    const lockOutcome = acquireSourceRepoLock(packet.projectRoot, owner);
    if (lockOutcome.status === "acquired" || lockOutcome.status === "already-held-by-me") {
        const output = cleanupTaskWorktree({
            projectRoot: packet.projectRoot, worktreePath: packet.worktree, taskNumber: packet.taskNumber, runId: packet.runId,
            rootSourceBranch: "staging",
        });
        if (output.retainedArtifacts.length === 0) {
            writeTailCursor(packet.taskNumber, packet.runId, null, packet.projectRoot);
            releaseSourceRepoLock(packet.projectRoot, owner);
        }
        return {
            box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
        };
    }
    throw new Error(`CLEAN_UP_WORKTREES: source repo lock is held by ${lockOutcome.owner}`);
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
```
No `try`/`catch` here: `cleanupTaskWorktree`'s own throw must propagate unchanged (the cursor was
already durably written before the risky call, matching the two-authority-write rule: write intent
before mutating, clear intent only after the mutation's success is confirmed). The extra
`releaseSourceRepoLock` call after a fully-empty result is a no-op whenever `cleanupTaskWorktree`
already released the lock itself (its own Step 5); it only matters the one time `cleanupTaskWorktree`
takes its F2 early-return path (nothing left to remove) after this function freshly reacquired the
lock moments earlier — that path never touches the lock on its own.

This also fixes `test_CLEAN_UP_WORKTREES_refusesAndMutatesNothingWhenTheSourceLockIsOwnedByAnotherRun`
to throw one step earlier (before `cleanupTaskWorktree` is ever called, since `acquireSourceRepoLock`
now refuses up front) while keeping every one of its existing assertions true: the worktree, branch,
and lease are untouched, and the lock stays owned by the other run.

Run `npm test -- scripts/tackle-tasks/mergeSucceededExit/CLEAN_UP_WORKTREES.test.ts`: all six tests
(three updated, three new) pass.

### Step 4 — `rebaseTaskWorktree` releases the source lock on every throw after acquisition

Test name: `test_rebaseTaskWorktree_releasesTheSourceLockWhenAnOperationalFailureThrows`, added to
`scripts/tackle-tasks/shared/rebaseTaskWorktree.test.ts`:
```ts
test("test_rebaseTaskWorktree_releasesTheSourceLockWhenAnOperationalFailureThrows", async () => {
    // Setup: a claimed task with a linked worktree, and a real rebase conflict between the
    // worktree branch and the source branch.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const runId = "run-throw";
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    writeFileSync(join(worktreePath, "shared.txt"), "from worktree\n");
    git(worktreePath, "add", "shared.txt");
    git(worktreePath, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(rootOrigin, "shared.txt"), "from staging\n");
    git(rootOrigin, "add", "shared.txt");
    git(rootOrigin, "commit", "-q", "-m", "staging edit");

    // Setup: shim git on PATH so the cleanup path's own "rebase --abort" fails too, forcing
    // rebaseGroupOntoSource into "cleanup-failed" (tests/mergeTaskWorktrees.test.ts's own technique
    // for this exact status, lines 815-854).
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), "fake-git-"));
    const shimPath = join(shimDir, "git");
    writeFileSync(shimPath, [
        "#!/bin/sh",
        'if [ "$1" = "-C" ] && [ "$3" = "rebase" ] && [ "$4" = "--abort" ]; then',
        '  echo "fake abort failure" >&2',
        "  exit 1",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
    ].join("\n"));
    execFileSync("chmod", ["+x", shimPath]);
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;

    // Test action: rebaseTaskWorktree throws (cleanup-failed is an operational failure, mapped to a throw).
    try {
        await assert.rejects(() => rebaseTaskWorktree({
            projectRoot: rootOrigin, worktreePath, taskNumber, runId, stepId: "rebase", rootSourceBranch: "main",
        }));
    } finally {
        process.env.PATH = originalPath;
    }

    // Verification: the source lock this call acquired is released, not stranded.
    assert.equal(readSourceRepoLock(rootOrigin), null);
});
```
Add imports: `mkdtempSync` to the existing `node:fs` import (line 5), `readSourceRepoLock` to the
existing `sourceRepoLock.ts` import (line 9). `execFileSync`, `join`, `tmpdir`, `writeFileSync` are
already imported.

This fails (RED): today the throw from `mapParentOutcome` propagates with the lock still held, so
`readSourceRepoLock(rootOrigin)` is non-null.

Production change in `scripts/tackle-tasks/shared/rebaseTaskWorktree.ts`:
1. Add `releaseSourceRepoLock` to the existing import from `./sourceRepoLock.ts` (line 4-6):
   ```ts
   import {
       acquireSourceRepoLock, buildLockOwner, refreshOwnedSourceRepoLockOrThrow, releaseSourceRepoLock,
   } from "./sourceRepoLock.ts";
   ```
2. Wrap the body from `refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);` (line 188) through
   the final `return result;` (line 218) in `try { ... } catch (error) { ... }`:
   ```ts
       try {
           refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);

           // Rebase only: pipeline-rebase.mmd runs no tests; pipeline-suite.mmd runs the suite afterwards.
           const submoduleReport = rebaseWorktreeSubmoduleLayersDeepestFirst(worktreePath, projectRoot, input.taskNumber, input.rootSourceBranch, true, null, false);
           if (submoduleReport.stoppedAt !== null) {
               const result: RebaseTaskWorktreeOutput = {
                   lock: "acquired", heldByOwner: null, recoveryCommand: null, ...mapSubmoduleStop(submoduleReport.stoppedAt),
               };
               persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "rebaseTaskWorktree", worktreePath, projectRoot, input.rootSourceBranch, result);
               return result;
           }

           const manifest = buildDiscoveryManifest(worktreePath, projectRoot, input.rootSourceBranch);
           const parentOutcome = rebaseParentOntoSourceAndTest(
               "",
               worktreePath,
               input.rootSourceBranch,
               directChildPathsInParent(manifest),
               createEmptyResolutionManifest(),
               true,
               null,
               false,
           );
           const mapped = mapParentOutcome(worktreePath, parentOutcome);
           if (mapped.stoppedAt === null && mapped.failureReason === null) {
               const receipts = captureSourceTipReceipts(worktreePath, projectRoot, input.rootSourceBranch);
               persistSourceTipReceipts(input.taskNumber, input.runId, input.stepId, worktreePath, projectRoot, input.rootSourceBranch, receipts);
           }
           const result: RebaseTaskWorktreeOutput = { lock: "acquired", heldByOwner: null, recoveryCommand: null, ...mapped };
           persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "rebaseTaskWorktree", worktreePath, projectRoot, input.rootSourceBranch, result);
           return result;
       } catch (error) {
           // Every operational throw here (mapSubmoduleStop/mapParentOutcome's default branches, or
           // any git call above) leaves the lock held unless released here. The deliberate
           // "conflicted" status returns normally above and never reaches this catch, so
           // FIX_CONFLICTS still finds the lock held, as intended. releaseSourceRepoLock reproves
           // ownership itself, so calling it unconditionally is always safe (matches
           // cleanupTaskWorktree.ts's existing catch-then-release precedent).
           releaseSourceRepoLock(projectRoot, owner);
           throw error;
       }
   ```
This is a `catch`-and-rethrow for durable resource cleanup on a resource this function itself
acquired a few lines above — not a swallowed error and not a fallback path; the error surfaces
unchanged to the caller.

Run `npm test -- scripts/tackle-tasks/shared/rebaseTaskWorktree.test.ts`: the new test passes and
all five pre-existing tests in the file still pass (none of them exercise the throwing branch, so
the new `try`/`catch` is a no-op for them).

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
If not all passing, follow up with `npm test 2>&1 | tail -50` and fix, repeating until green.
