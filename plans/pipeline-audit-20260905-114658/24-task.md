# Task 24 plan — worktree reset and creation are not crash-safe (PRE-12)

No `TaskGet` tool was available in this session to fetch task 24's stored description by
id. This plan instead uses the audit text the orchestrator pointed at as the spec, verified
against the live pipeline:

- `plans/pipeline-audit-codex-20260905-113523.md`, section "Missing critical task: worktree
  reset and creation are not crash-safe": "`_createFreshTaskWorktree.ts:1-2` explicitly says
  a mid-step crash leaves a partial worktree for manual cleanup. `RESET_WORKTREE` can delete
  the old worktree and its checkpoint before replacement succeeds... Required task: use the
  existing external creation-journal pattern, or an equivalent durable intent, for the live
  `CREATE_WORKTREE` and `RESET_WORKTREE` blocks. Test termination after lease creation,
  worktree deletion, Git worktree creation, branch reset, and task-state publication."
- `plans/audit-2026-09-05/audit-exits.md` row **PRE-12** (line 247): "crash any time after
  `removeWorktreeAndBranch` (line 18) and before `updateCurrentTaskRun` (line 24) completes
  ... `removeWorktreeAndBranch` deletes the old worktree, destroying `plans/checkpoint.json`
  with it; resume's `usableWorktree` check fails, falls back to marking the run
  'agent-failed'." Line 256's note adds: "PRE-12 can leave a physical `.lease` file at a
  recreated worktree path un-recorded in tasks.json's `leaseRunId`, orphaning it."

Fixing `resumeRun.ts`'s checkpoint-replay fallback (the "falls back to agent-failed" half of
PRE-12) is a separate, larger concern the audit text does not assign here — it names one
concrete required task: a durable intent for the two live blocks so a crash mid
delete-or-recreate is provably recoverable by *any* later invocation of these blocks (a
manual retry, or a supervisor re-driving the same task), independent of whether the hook's
own checkpoint-replay path can reach them. That is this plan's scope.

## Scope confirmation

- `scripts/tackle-tasks/shared/_createFreshTaskWorktree.ts` (22 lines, read in full). Its own
  header comment (lines 1-2) is the exact gap the audit quotes: "ported from
  createTaskWorktree.ts minus its F11 journal/rollback wrapper... no journal-based rollback
  across process boundaries; a mid-step crash throws and leaves a partial worktree for a
  human to clean up. Add the journal back if a run-step block ever needs to recover one
  automatically." Its `createFreshTaskWorktree(taskNumber, runId, projectRoot): string`
  (lines 8-21) independently re-reads the task, builds a `TaskGroup`, calls
  `createWorktreeForGroup` (line 18), and calls `configureGeneratedArtifactIsolation` (line
  19) — with **no journal, no rollback, no recovery of a retained journal**.
- `scripts/tackle-tasks/shared/createTaskWorktree.ts` (205 lines, read in full). Its
  `createTaskWorktree(taskNumber, runId, projectRoot): { worktree, branch }` (lines 159-193)
  is the "existing external creation-journal pattern" the audit refers to: it already
  journals intent (`taskWorktreeCreateJournalPath`, lines 22-33, 176-180) before calling
  `createWorktreeForGroup` (line 184) and `updateCurrentTaskRun` (line 185), already rolls
  back on a **thrown** error via `rollbackCreateTaskWorktree` (lines 49-94), and already
  recovers a **retained** journal from a prior crashed call via
  `recoverRetainedCreateJournal` (lines 96-157), which it calls unconditionally at the top of
  `createTaskWorktree` (line 164) before doing anything else. It is fully covered by
  `scripts/tackle-tasks/shared/createTaskWorktree.test.ts` (354 lines, read in full) — 10
  tests including 5 that hand-write a retained journal to simulate a crash and assert clean,
  single-call recovery (lines 183-354). Its only current callers are
  `scripts/tackle-tasks/rebase/REBASE_ONTO_TARGET_BRANCH.test.ts` (a test file) — confirmed
  via `rg -n "createTaskWorktree("` across `scripts/` and `tests/`, no production caller
  today. Its own CLI-entrypoint comment (lines 197-198) names a stale path
  (`scripts/steps/pipeline-worktreeCheck/...`) that does not exist in this repo; this is a
  pre-existing inaccurate comment, out of scope for this task, not touched.
- `scripts/prepareTasks.ts` (675 lines, read in full). `createWorktreeForGroup(repoRoot,
  group, runId)` (lines 383-497) is called by both `createFreshTaskWorktree` and
  `createTaskWorktree`. Two branches, confirmed live at these exact lines:
  - existing-directory branch: `lease = acquireTaskWorktreeLease(worktreePath, runId);` at
    line 437, then `execFileSync("git", ["-C", worktreePath, "checkout", "--force", "-B",
    branchName, stagingTip], { stdio: "ignore" });` at lines 452-456 (the "branch reset" step
    named by the audit).
  - fresh branch: `lease = acquireTaskWorktreeLease(worktreePath, runId);` at line 463, then
    `execFileSync("git", ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath,
    stagingTip], { stdio: "ignore" });` at lines 472-476 (the "Git worktree creation" step).
  `acquireTaskWorktreeLease` (lines 321-340) does an unconditional `openSync(leasePath, "wx",
  ...)` — it throws "already owned by a live run" on **any** existing lease file, including
  one this exact run itself wrote in a killed prior attempt at the same worktree path. This
  is the concrete failure mode the audit's own header comment describes ("leaves a partial
  worktree for a human to clean up"): a retry after a crash mid-`createWorktreeForGroup`
  throws instead of recovering, because nothing outside `createTaskWorktree`'s journal knows
  the retry is the same run reclaiming its own in-flight work.
- `scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.ts` (16 lines, read in full).
  `main` (lines 8-12) calls `createFreshTaskWorktree` (line 10) and returns; it never calls
  `updateCurrentTaskRun` itself — that is `TAKE_WORKTREE_LEASE.ts`'s job, confirmed by reading
  `scripts/tackle-tasks/preambleStatusCheck/TAKE_WORKTREE_LEASE.ts` (16 lines) — so
  `createFreshTaskWorktree` gaining an internal `updateCurrentTaskRun` call (via delegating to
  `createTaskWorktree`) does not change when task state is *first* recorded relative to
  claiming; `CREATE_WORKTREE.test.ts` (confirmed, read in full) already calls `claimTask(1,
  "run-a", root)` before invoking `CREATE_WORKTREE`'s `main`, so `state.active` is always
  `true` by the time `updateCurrentTaskRun` would run — it will not throw "no active run".
  `TAKE_WORKTREE_LEASE.ts`'s own `updateCurrentTaskRun` call afterward becomes redundant
  (same values) but harmless; left as-is, not removed (no unrequested refactor).
- `scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.ts` (30 lines, read in full).
  `main` (lines 11-26): line 13-16 verifies `state.leaseRunId === packet.runId` (reproving
  ownership) before doing anything destructive; line 17 `deleteTaskMergePersistence` and line
  18 `removeWorktreeAndBranch(packet.projectRoot, packet.worktree, packet.branch);` (the
  "worktree deletion" step named by the audit); lines 20-22 release a stale sibling `.lease`
  file if the prior attempt's crash left one; line 23 `createFreshTaskWorktree` (the
  recreate); line 24 `updateCurrentTaskRun`. Confirmed via `scripts/mergeTaskWorktrees.ts:506-519`
  (read) that `removeWorktreeAndBranch` is idempotent (`existsSync` guard on the worktree,
  `show-ref` guard before `branch -D`) and via
  `scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.test.ts` (67 lines, read in full)
  that an existing test, `test_RESET_WORKTREE_runsTwiceWithTheSameInput` (lines 42-66),
  already proves a clean double-run is idempotent end-to-end.
- `scripts/tackle-tasks/shared/resumeRun.ts` (read in full, `findResumeEntry` at lines
  13-49). Live-traced against the RESET_WORKTREE crash: `usableWorktree` (line 20) goes false
  once the worktree directory and its `plans/checkpoint.json` are deleted; row 4 (lines 40-45,
  `state.active` true, no usable worktree, not completed) unconditionally marks the run
  `"agent-failed"` and returns `null` — it never re-invokes `RESET_WORKTREE`. This is the
  actual automatic-resume path (`runStepHook.ts:297` calls `findResumeEntry`, confirmed via
  `rg -n "findResumeEntry"`), distinct from directly re-calling `RESET_WORKTREE.ts`'s own
  `main()`, which a test can do but the running pipeline never does on its own. See Step 4.
- `scripts/tackle-tasks/shared/resumeRun.test.ts` (read `test_findResumeEntry_endsARunThatDiedBeforeAWorktreeAndReturnsNull`
  and `test_findResumeEntry_returnsNullWhenTheWorktreeIsGone` in full, lines 183-209) — the
  existing coverage of `findResumeEntry`'s row 4, both for a task that never got a worktree
  (`state.worktree === null`); neither fixture matches this task's scenario (a worktree that
  existed and was deleted mid-reset), confirming the gap is real and untested. Extended with
  one new test.
- `scripts/tackle-tasks/shared/writeTaskBrief.ts` (read in full, lines 63-73).
  `configureGeneratedArtifactIsolation(taskNumber, worktreePath)` runs `git ls-files` for a
  fixed pattern list (`GENERATED_ARTIFACT_PATTERNS`, lines 11-17) and applies `git
  update-index --skip-worktree` to whatever is tracked — confirmed idempotent (re-flagging an
  already skip-worktree path is a no-op, not an error). Not edited; cited as evidence for
  Step 3's fix.
- `scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.test.ts` (30 lines, read in
  full) and `scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.test.ts` (above) — box-
  level tests, extended with one kill-point test each.
- `scripts/tackle-tasks/resetTask.ts` was checked (`rg -n "mutation-guard"` across
  `scripts/`) — it unconditionally `rmSync`s the source lock and its mutation guard as part
  of a developer-only manual reset tool, unrelated to worktree creation/reset crash safety.
  Not touched by this task.

Files this task edits: `_createFreshTaskWorktree.ts`, `prepareTasks.ts`,
`createTaskWorktree.ts`, `RESET_WORKTREE.ts`, `resumeRun.ts`, plus one new shared module
(`resetIntent.ts`) and four test files (`CREATE_WORKTREE.test.ts`, `createTaskWorktree.test.ts`,
`RESET_WORKTREE.test.ts`, `resumeRun.test.ts`).

## Steps

### Step 1 — delegate `createFreshTaskWorktree` to the existing journal, proven by a real kill

**Test: `test_CREATE_WORKTREE_recoversAfterBeingKilledRightAfterGitWorktreeAdd`**
(new, in `scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.test.ts`)

Plain-English steps:
1. Seed a committed repo and an open task with no prior worktree; `claimTask(1, "run-a",
   root)`.
2. Spawn a **real child process** that runs `CREATE_WORKTREE.ts`'s own `main()` for task 1,
   run "run-a", with a new test-only env var set so the child kills itself right after `git
   worktree add` succeeds but before anything else finishes.
3. Assert the child actually died of `SIGKILL` (proves the kill point really fired mid-box,
   not that the box merely finished and exited).
4. Call `CREATE_WORKTREE.ts`'s `main()` again, same packet, **in-process**, and assert it
   returns cleanly (no throw) with a worktree on `task-1`, submodules populated, the one
   surviving `.lease` file naming `"run-a"` (the current run's own ownership fence, which
   `createWorktreeForGroup` deliberately leaves held on success — confirmed at
   `scripts/prepareTasks.ts:383-496`, no release call on any success path, only inside each
   `catch`), and no `.create-journal.json` file left at the worktree path.

Before any production change, this test is RED for a structural reason: the kill hook it
needs (`CREATEWORKTREEFORGROUP_TEST_KILL_AFTER=gitCreate`) does not exist yet anywhere in
`createWorktreeForGroup`, so the child cannot actually be killed at that point — it runs to
completion and exits 0, and `assert.equal(signal, "SIGKILL")` fails. Adding the hook (this
step) makes the kill real; whether recovery then succeeds depends on the delegation change
below.

Minimum production change, part A — add the kill hook (`scripts/prepareTasks.ts`):

```ts
// Test-only: SIGKILLs this process right after the named step of createWorktreeForGroup
// finishes, so a retry can be exercised against a real process death, not a thrown error.
const CREATE_WORKTREE_FOR_GROUP_TEST_KILL_AFTER_ENV = "CREATEWORKTREEFORGROUP_TEST_KILL_AFTER";
function killSelfForTest(step: "lease" | "gitCreate" | "gitReset"): void {
    if (process.env[CREATE_WORKTREE_FOR_GROUP_TEST_KILL_AFTER_ENV] === step) process.kill(process.pid, "SIGKILL");
}
```

Placed once, module-scope, above `createWorktreeForGroup`. Called at four existing lines
inside `createWorktreeForGroup` (no other line in that function changes):

- after line 437 `lease = acquireTaskWorktreeLease(worktreePath, runId);` (existing-dir
  branch): add `killSelfForTest("lease");`
- after line 456's `execFileSync(... "checkout", "--force", "-B", ...)` call closes: add
  `killSelfForTest("gitReset");`
- after line 463 `lease = acquireTaskWorktreeLease(worktreePath, runId);` (fresh branch): add
  `killSelfForTest("lease");`
- after line 476's `execFileSync(... "worktree", "add", "-B", ...)` call closes: add
  `killSelfForTest("gitCreate");`

Minimum production change, part B — delegate `_createFreshTaskWorktree.ts`:

```ts
// Shared by CREATE_WORKTREE and RESET_WORKTREE: the physical git worktree creation step.
// RETIRED (task 24): // ponytail: no journal-based rollback across process boundaries; a mid-step crash throws and leaves a partial worktree for a human to clean up. Add the journal back if a run-step block ever needs to recover one automatically.
// CREATE_WORKTREE and RESET_WORKTREE now delegate to createTaskWorktree.ts's already-tested
// F11 journal/rollback wrapper instead of calling createWorktreeForGroup directly.
import { createTaskWorktree } from "./createTaskWorktree.ts";

export function createFreshTaskWorktree(taskNumber: number, runId: string, projectRoot: string): string {
    return createTaskWorktree(taskNumber, runId, projectRoot).worktree;
}
```

This removes the now-dead direct imports of `readTaskFile`, `resolveTaskFiles`,
`TaskRecord`, `createWorktreeForGroup`, `modifiableFiles`, `TaskGroup`, and
`configureGeneratedArtifactIsolation` from this file (all now handled inside
`createTaskWorktree`, which already imports and calls every one of them, including
`configureGeneratedArtifactIsolation` at its own line 191).

Why this makes the test GREEN: on the killed attempt, `createTaskWorktree` already wrote its
create-journal (lines 176-180) *before* calling `createWorktreeForGroup`, so the journal is
retained on disk naming `(taskNumber: 1, runId: "run-a", worktreePath, branch: "task-1")`.
The physical worktree and branch exist (the kill happens right after `git worktree add`
succeeds) but task state was never written (`updateCurrentTaskRun` never ran). On the retry,
`recoverRetainedCreateJournal` (lines 96-157) finds this journal, confirms the lease still
names `run-a` (the same run retrying), confirms `journal.runId === runId`, finds
`stateMatchesJournal` false (task state never got the worktree recorded), and takes the
"not finished" branch: calls `removeWorktreeAndBranch` to clear the half-built worktree,
releases the lease, deletes the journal, and returns `null` — after which
`createTaskWorktree`'s outer call proceeds to build a fresh worktree from scratch, this time
uninterrupted, and records task state normally. No partial worktree is left for a human to
clean up.

### Step 2 — kill-point tests for the two remaining `createWorktreeForGroup` points

No new production code: the hooks added in Step 1 already exist at all four call sites; this
step only adds unit-level proof for the two points Step 1's box test did not directly
exercise, driven straight against `createTaskWorktree` (not through a box), matching the
existing style of `createTaskWorktree.test.ts`.

**Test: `test_createTaskWorktree_recoversAfterBeingKilledRightAfterAcquiringTheLease`**
(new, in `scripts/tackle-tasks/shared/createTaskWorktree.test.ts`)

1. Fresh repo, task 1, `claimTask(1, "run-a", root)`, no prior worktree.
2. Spawn a child running `createTaskWorktree(1, "run-a", root)` with
   `CREATEWORKTREEFORGROUP_TEST_KILL_AFTER=lease`.
3. Assert `SIGKILL`.
4. Assert `existsSync(taskWorktreeLeasePath(expectedWorktree))` is true and names `"run-a"`
   (the lease survived the kill, no git worktree exists yet).
5. Call `createTaskWorktree(1, "run-a", root)` again in-process; assert it returns cleanly, a
   real worktree exists on `task-1`, and no journal file remains
   (`taskWorktreeCreateJournalPath(expectedWorktree)`).

Failing assertion before the hook exists: step 3's `assert.equal(signal, "SIGKILL")`. No
other production change needed — `recoverRetainedCreateJournal`'s "not finished" branch
(same code path as Step 1) already handles a lease-only partial state correctly (it treats
"lease exists, no task state" the same as "worktree exists, no task state": clear, retry).

**Test: `test_createTaskWorktree_recoversAfterBeingKilledRightAfterResettingAnExistingBranch`**
(new, in `scripts/tackle-tasks/shared/createTaskWorktree.test.ts`)

1. Fresh repo, task 1. Seed a *leftover* worktree directory at the convention path with no
   active lease, simulating a directory a previous run left behind after its lease was
   cleanly released elsewhere: call `createWorktreeForGroup(root, { groupId: 1,
   taskNumbers: [1], filePaths: [], scope: "declared" }, "run-a")` directly, then
   `releaseTaskWorktreeLease({ worktreePath: expectedWorktree, runId: "run-a" })`.
   `claimTask(1, "run-b", root)`.
3. Spawn a child running `createTaskWorktree(1, "run-b", root)` with
   `CREATEWORKTREEFORGROUP_TEST_KILL_AFTER=gitReset`.
4. Assert `SIGKILL`.
5. Assert the lease at `expectedWorktree` now names `"run-b"` (acquired before the kill), and
   the create-journal at `taskWorktreeCreateJournalPath(expectedWorktree)` also names
   `"run-b"`.
6. Call `createTaskWorktree(1, "run-b", root)` again in-process; assert it returns cleanly on
   `task-1`, task state records `"run-b"`, and no journal remains.

### Step 3 — kill points for task-state publication and isolation configuration

Live check: `createTaskWorktree`'s ordinary path (lines 187-189) calls `unlinkSync(journalPath)`
**before** `configureGeneratedArtifactIsolation(taskNumber, worktree)`; the completion branch
of `recoverRetainedCreateJournal` (lines 138-142) unlinks the journal and returns without ever
calling `configureGeneratedArtifactIsolation` at all. So a kill after `updateCurrentTaskRun`
recovers the worktree but a retry can return it with skip-worktree isolation never installed,
and a kill after the journal is unlinked (ordinary path) leaves no durable evidence that
isolation configuration was ever attempted. `configureGeneratedArtifactIsolation`
(`scripts/tackle-tasks/shared/writeTaskBrief.ts:63-73`) is confirmed idempotent: it runs `git
ls-files` for a fixed pattern list and reapplies `git update-index --skip-worktree` to
whatever is tracked, safe to call more than once. Fixing this means: configure isolation
*before* clearing the journal on every path, including the completion-recovery branch.

**Test: `test_createTaskWorktree_recoversAfterBeingKilledRightAfterRecordingTaskState`**
(new, in `scripts/tackle-tasks/shared/createTaskWorktree.test.ts`)

1. Fresh repo, task 1 with a `plans/brief-1.md` tracked in the seed commit (so
   `configureGeneratedArtifactIsolation` has something real to flag), `claimTask(1, "run-a",
   root)`, no prior worktree.
2. Spawn a child running `createTaskWorktree(1, "run-a", root)` with
   `CREATETASKWORKTREE_TEST_KILL_AFTER=state`.
3. Assert `SIGKILL`.
4. Assert `readTaskRunState(1, root).worktree` equals the expected worktree path and
   `leaseRunId` equals `"run-a"` (task state was published before the kill), the
   create-journal still exists (the kill happens before isolation configuration or its own
   `unlinkSync`), and `plans/brief-1.md` inside the worktree is **not yet** skip-worktree
   (`git -C worktree ls-files -v -- plans/brief-1.md` does not start with `S`).
5. Call `createTaskWorktree(1, "run-a", root)` again in-process; assert it returns the exact
   same worktree path unchanged (not rebuilt — the "genuinely finished, journal only"
   recovery path already covered abstractly by
   `test_createTaskWorktree_recoversALateCompletedJournalWithoutTouchingTheGoodWorktree`,
   here proven against a real process death instead of a hand-written journal), the journal
   is gone, **and** `plans/brief-1.md` is now skip-worktree — proving the completion-recovery
   branch itself installs isolation rather than skipping it.

**Test: `test_createTaskWorktree_recoversAfterBeingKilledRightAfterConfiguringIsolation`**
(new, in `scripts/tackle-tasks/shared/createTaskWorktree.test.ts`)

1. Same fixture as above.
2. Spawn a child running `createTaskWorktree(1, "run-a", root)` with
   `CREATETASKWORKTREE_TEST_KILL_AFTER=isolation`.
3. Assert `SIGKILL`.
4. Assert `plans/brief-1.md` inside the worktree is now skip-worktree, but the create-journal
   still exists (the kill happens before the journal's own `unlinkSync`) — the one window
   where isolation is configured but not yet durably marked finished.
5. Call `createTaskWorktree(1, "run-a", root)` again in-process; assert it returns cleanly,
   the journal is gone, and `plans/brief-1.md` is still skip-worktree (re-running
   `configureGeneratedArtifactIsolation` a second time is a no-op, not an error).

Minimum production change (`scripts/tackle-tasks/shared/createTaskWorktree.ts`):

```ts
// Test-only: SIGKILLs this process right after the named step finishes, so a retry can be
// exercised against a real process death, not a thrown error.
const CREATE_TASK_WORKTREE_TEST_KILL_AFTER_ENV = "CREATETASKWORKTREE_TEST_KILL_AFTER";
function killSelfForTest(step: "state" | "isolation"): void {
    if (process.env[CREATE_TASK_WORKTREE_TEST_KILL_AFTER_ENV] === step) process.kill(process.pid, "SIGKILL");
}
```

In `recoverRetainedCreateJournal`'s completion branch (currently lines 138-142), configure
isolation before clearing the journal instead of skipping it:

```ts
        if (stateMatchesJournal && owner !== null) {
            configureGeneratedArtifactIsolation(journal.taskNumber, journal.worktreePath);
            unlinkSync(journalPath);
            recovered = { worktree: journal.worktreePath, branch: journal.branch };
            return;
        }
```

In `createTaskWorktree`'s ordinary path (currently lines 182-190), add the "state" kill
point, then reorder so isolation is configured before the journal is cleared, with the
"isolation" kill point between the two:

```ts
    try {
        worktree = createWorktreeForGroup(projectRoot, group, runId);
        updateCurrentTaskRun(taskNumber, runId, { worktree, leaseRunId: runId }, projectRoot);
        killSelfForTest("state");
    } catch (originalError) {
        rollbackCreateTaskWorktree(projectRoot, journal, journalPath, originalError);
    }

    configureGeneratedArtifactIsolation(taskNumber, worktree);
    killSelfForTest("isolation");
    unlinkSync(journalPath);
    return { worktree, branch };
```

Why the first test is GREEN: on retry, `recoverRetainedCreateJournal` finds
`stateMatchesJournal && owner !== null` (task state and the physical lease both already name
`"run-a"`) and now runs `configureGeneratedArtifactIsolation` itself before unlinking the
journal, instead of returning early with isolation never installed. Why the second test is
GREEN: the journal still exists at the kill point (unlink is now the very last line), so the
retry takes the exact same completion-recovery branch and re-runs
`configureGeneratedArtifactIsolation` — idempotent, so re-flagging an already skip-worktree
path changes nothing.

### Step 4 — a reset-intent that survives the worktree's own deletion, reconciled by the real resume path

Live check confirms this needs more than a retry hook. `resumeRun.ts:13-49`
(`findResumeEntry`) computes `usableWorktree = worktree !== null && existsSync(worktree) &&
existsSync(checkpointPath(worktree))` (line 20). After `removeWorktreeAndBranch` runs, both
conjuncts after `worktree !== null` are false (the directory and the `plans/checkpoint.json`
it held are gone), so `usableWorktree` is false. `state.history`'s newest run has no
`exitType` of `"completed"` (row 3 does not match), so row 4 fires: `state.active` is `true`,
so `findResumeEntry` calls `writeTaskExitNotes({ exitType: "agent-failed", ... })`,
`endTaskRun(...)`, and returns `null` (lines 40-44) — it never calls `RESET_WORKTREE` again.
This is confirmed by the existing test
`test_findResumeEntry_endsARunThatDiedBeforeAWorktreeAndReturnsNull`
(`resumeRun.test.ts:183-197`), which exercises the same row 4 branch for a different cause
(no worktree ever created) and asserts exactly this outcome. A test that kills
`RESET_WORKTREE.ts`'s process and then calls `RESET_WORKTREE.ts`'s own `main()` again
directly never exercises this branch at all — it proves nothing about what the real,
automatic resume path (`findResumeEntry`, the function `/run-step` actually calls per
`runStepHook.ts:297`) does after a crash. Fixing this requires a durable intent that
survives the worktree's own deletion — the same reason `createTaskWorktree`'s create-journal
lives beside the worktree, not inside it — plus teaching `findResumeEntry` to reconcile it
before giving up.

**New shared module: `scripts/tackle-tasks/shared/resetIntent.ts`**

Mirrors `checkpoint.ts`'s existing shape (type + path function + read + write) for a new,
narrower durable artifact — RESET_WORKTREE's own intent, not the general per-block
checkpoint:

```ts
// Durable intent for RESET_WORKTREE's delete-then-recreate, written outside the worktree so
// it survives the worktree's own deletion (which also destroys plans/checkpoint.json).
// resumeRun.ts reads this to resume at RESET_WORKTREE instead of giving up.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeJsonAtomically } from "../../taskStateLock.ts";

export type ResetIntent = { taskNumber: number; runId: string; worktreePath: string; branch: string; createdAt: string };

export function resetIntentPath(worktreePath: string): string {
    return `${worktreePath}.reset-intent.json`;
}

export function writeResetIntent(intent: ResetIntent): void {
    writeJsonAtomically(resetIntentPath(intent.worktreePath), intent);
}

export function readRetainedResetIntent(worktreePath: string): ResetIntent | null {
    const path = resetIntentPath(worktreePath);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as ResetIntent;
}

export function clearResetIntent(worktreePath: string): void {
    unlinkSync(resetIntentPath(worktreePath));
}
```

**Test: `test_findResumeEntry_resumesAtResetWorktreeAfterAKillRightAfterDeletingTheOldWorktree`**
(new, in `scripts/tackle-tasks/shared/resumeRun.test.ts`)

1. Build the same fixture as `RESET_WORKTREE.test.ts`'s
   `test_RESET_WORKTREE_tearsDownAndRecreatesACleanWorktreeOnTheTaskBranch`: committed repo
   with a submodule, task 1 claimed under `"run-old"`, a first worktree created and recorded,
   `takeLeaseBeforeReset` run to produce the `beforeReset` packet.
2. Spawn a child running `RESET_WORKTREE.ts`'s own `main(JSON.stringify(beforeReset))` with
   `RESETWORKTREE_TEST_KILL_AFTER_DELETE=1`.
3. Assert `SIGKILL`.
4. Assert the old worktree directory no longer exists, `refs/heads/task-1` no longer exists
   in the root repo, the sibling `.lease` file at the (now-deleted) worktree path still
   exists and still names `"run-old"`, and the new sibling `.reset-intent.json` file exists
   at that same path, naming `taskNumber: 1`, `runId: "run-old"`, `branch: "task-1"`. Assert
   `readTaskRunState(1, root).active` is still `true` (the run has not been abandoned).
5. Call `findResumeEntry(1, tasksPath)` — the real, automatic resume decision, not
   `RESET_WORKTREE.main` called directly. Assert it returns `{ block:
   "pipeline-preambleStatusCheck.mmd::RESET_WORKTREE", input }` (not `null`), and that
   `JSON.parse(input)` names task 1, run `"run-old"`, and the same worktree/branch —
   proving the automatic path resumes rather than marking the run `"agent-failed"`.
6. Assert `readTaskRunState(1, root).active` is still `true` and its newest run's `exitType`
   is still `null` — the run is never marked `"agent-failed"` and abandoned.
7. Feed `input` into `RESET_WORKTREE.ts`'s own `main()`; assert it completes cleanly, a fresh
   worktree exists on `task-1` with no leftover `dirty.txt`-style state, the one surviving
   `.lease` file names `"run-old"` (the current run's ownership fence, not released — see
   Step 1's lease-ownership note), no `.create-journal.json` or `.reset-intent.json` file
   survives at the worktree path, and `readTaskRunState(1, root).worktree` equals the new
   output worktree.

Minimum production change, part A (`scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.ts`):
write the intent before the first destructive step, clear it only after recreate and state
publication both succeed.

```ts
// Test-only: SIGKILLs this process right after the old worktree/branch are torn down, before
// the stale-lease cleanup and recreate steps run.
function killSelfForTest(): void {
    if (process.env.RESETWORKTREE_TEST_KILL_AFTER_DELETE === "1") process.kill(process.pid, "SIGKILL");
}

export function main(input: string): EntryPacket {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const state = readTaskRunState(packet.taskNumber, packet.projectRoot);
    if (state.leaseRunId !== packet.runId) {
        throw new Error(`worktree lease for task ${packet.taskNumber} is not held by run "${packet.runId}", refusing reset`);
    }
    writeResetIntent({
        taskNumber: packet.taskNumber, runId: packet.runId, worktreePath: packet.worktree,
        branch: packet.branch, createdAt: new Date().toISOString(),
    });
    deleteTaskMergePersistence(packet.projectRoot, packet.branch);
    removeWorktreeAndBranch(packet.projectRoot, packet.worktree, packet.branch);
    killSelfForTest();
    // A rerun of a killed pass leaves the physical lease from the worktree this just tore down.
    if (existsSync(taskWorktreeLeasePath(packet.worktree))) {
        releaseTaskWorktreeLease({ worktreePath: packet.worktree, runId: packet.runId });
    }
    const worktree = createFreshTaskWorktree(packet.taskNumber, packet.runId, packet.projectRoot);
    updateCurrentTaskRun(packet.taskNumber, packet.runId, { worktree, leaseRunId: packet.runId }, packet.projectRoot);
    clearResetIntent(packet.worktree);
    return { ...packet, box: "RESET_WORKTREE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, worktree, docsMode: "AUTOGEN" };
}
```

(Add `import { clearResetIntent, writeResetIntent } from "../shared/resetIntent.ts";` to this
file's existing import block.)

Minimum production change, part B (`scripts/tackle-tasks/shared/resumeRun.ts`): reconcile a
retained reset intent in row 4, before giving up.

```ts
    if (state.active) { // row 4
        if (worktree !== null) {
            const resetIntent = readRetainedResetIntent(worktree);
            if (resetIntent !== null) {
                if (resetIntent.runId === newest!.runId) {
                    const input = JSON.stringify({
                        box: "TAKE_WORKTREE_LEASE_BEFORE_RESET", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
                        taskNumber, runId: newest!.runId, projectRoot,
                        worktree: resetIntent.worktreePath, branch: resetIntent.branch,
                        docsMode: "", planFile: "", exitType: "", exitNote: "",
                    });
                    return { block: "pipeline-preambleStatusCheck.mmd::RESET_WORKTREE", input };
                }
            }
        }
        writeTaskExitNotes({
            taskNumber, runId: newest!.runId, projectRoot,
            exitType: "agent-failed", exitNote: "run stopped before a worktree existed",
        });
        endTaskRun(taskNumber, newest!.runId, projectRoot);
        return null;
    }
```

(Add `import { readRetainedResetIntent } from "./resetIntent.ts";` to this file's existing
import block. `worktree`, `newest`, `taskNumber`, and `projectRoot` are all already in scope
at this point in `findResumeEntry` — no other line in the function changes.) The existing
test `test_findResumeEntry_endsARunThatDiedBeforeAWorktreeAndReturnsNull` still passes
unmodified: its fixture never creates a worktree, so `worktree` is `null` there and the new
`if (worktree !== null)` branch is skipped entirely, falling through to the same
`"agent-failed"` outcome as before.

Why the new test is GREEN: the reset-intent is written before any destructive step and named
in the retry's own kill-point assertion (step 4) as surviving the worktree's deletion;
`findResumeEntry` reads it, confirms `resetIntent.runId` matches the newest run (reproving
ownership before acting on it), and hands back a `RESET_WORKTREE` resume entry instead of
abandoning the run; feeding that entry's `input` into `RESET_WORKTREE.main` exercises the
exact same idempotent teardown/lease-cleanup/recreate sequence already established in this
plan's earlier steps, and `clearResetIntent` removes the intent once recreate and state
publication both land.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
npm test -- scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.test.ts
npm test -- scripts/tackle-tasks/shared/createTaskWorktree.test.ts
npm test -- scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.test.ts
npm test -- scripts/tackle-tasks/shared/resumeRun.test.ts
```
Expected: every listed test file passes, 0 failures, including the six new kill-point
tests.

Then the full suite, using the technique from the user's CLAUDE.md:

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
If not "all passing", follow up with `npm test 2>&1 | tail -50` and fix, repeating until
green. Do not re-run `npm test` again once it reports "all passing".
