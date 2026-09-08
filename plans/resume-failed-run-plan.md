# Plan: resume a run at the block where it stopped

Goal: launch `/tackle-tasks N`, kill the workflow during any block, run `/tackle-tasks N` again, and the run continues where it stopped. No `resume` keyword. The hook decides where the run is. The only runs that do not resume: the task completed, the worktree disappeared, or the Claude API is down (then nothing runs at all).

## 0. Where are we? (decided by the hook at the start of every `/run-step PREAMBLE_STATUS_CHECK` call)

Read `tasks.json` for task N (`projectRoot` derived as in `preambleStatusCheck/PREAMBLE_STATUS_CHECK.ts:16`, then `readTaskRunState`). Let `newest` be the last history record.

| # | State                                                                        | What the hook does |
|---|------------------------------------------------------------------------------|--------------------|
| 1 | Task N is not in `tasks.json`                                                | Walk from PREAMBLE_STATUS_CHECK. It reports `invalid-number`. The task completed and was archived. |
| 2 | `run.worktree` names a folder that exists and holds `plans/checkpoint.json`  | **Resume.** `prepareResume`, mark the checkpoint resumed, walk from `checkpoint.block` with `checkpoint.input`. Both `running` and `failed` states resume. |
| 3 | No usable worktree, `newest.exitType === "completed"`                        | CLEAN_UP_WORKTREES removed the worktree, the archive did not land. **Resume the merge tail:** input `{ "box": "CLEAN_UP_WORKTREES", "scriptSignal": "continue", "projectRoot", "taskNumber", "runId": newest.runId }` (the exact CLEAN_UP_WORKTREES output shape); walk from `pipeline-mergeSucceededExit.mmd::BUILD_CLOSURE_NOTE` when `run.active`, from `pipeline-mergeSucceededExit.mmd::ARCHIVE_TASK` when not. |
| 4 | No usable worktree, `run.active === true`                                    | The run died before a worktree existed. `writeTaskExitNotes({ exitType: "agent-failed", exitNote: "run stopped before a worktree existed" })`, `endTaskRun`, then walk from PREAMBLE_STATUS_CHECK. MARK_TASK_ACTIVE starts a new record. |
| 5 | Anything else                                                                | Walk from PREAMBLE_STATUS_CHECK, as today. The worktree disappeared or never existed; the preamble builds a new one. |

"No usable worktree" = `run.worktree` is null, or the folder is gone, or it holds no `plans/checkpoint.json`.

Known gap, one second wide: a kill inside CREATE_WORKTREE after the folder appears and before the hook writes the first checkpoint lands in row 5 with a worktree the preamble may call `not-resumable`. Fix by hand: delete that worktree. Not worth a code path.

To start a task over instead of resuming, delete its worktree by hand.

## 1. The checkpoint file

One JSON file per task, inside the task's worktree, written only by `scripts/runStepHook.ts`:

Path: `join(packet.worktree, "plans", "checkpoint.json")`.
`plans/` in a worktree is already the pipeline artifact folder (`plan.json`, `codex-review.json`, `test-review.json` live there) and is gitignored by the project. `commitTaskWork` stages only owned files, and the fence reads committed diffs, so the file never reaches a commit.

The hook writes it only when the block input packet has a non-empty `worktree` string and `existsSync(worktree)` is true. Blocks before CREATE_WORKTREE leave no checkpoint; row 4 covers a kill there.

Shape, in a new file `scripts/tackle-tasks/shared/checkpoint.ts` that exports the type plus `checkpointPath(worktree)`, `readCheckpoint(worktree): Checkpoint | null`, `writeCheckpoint(worktree, checkpoint)`. The hook and the counter blocks (section 6) both import it:

```ts
export type Checkpoint = {
    taskNumber: number;
    passId: string;                // randomUUID() from the hook, one per block execution; reused on resume
    runId: string;                 // packet.runId; never empty once a worktree exists
    projectRoot: string;           // packet.projectRoot
    block: string;                 // "diagram.mmd::BOX", the block to run next
    input: string;                 // the exact JSON string that block receives
    state: "running" | "failed";
    sourceLockHeld: boolean;       // true when this run owned the source lock at failure time
    exitType: string;              // the failing block's exitType; "" while running
    exitNote: string;              // the failing block's exitNote; "" while running
    resumedFrom: { block: string; exitType: string; exitNote: string } | null; // set by the hook when it resumes; kept by every later write
};
```

## 2. When the hook writes the checkpoint

All edits in `walkFromStep` (`scripts/runStepHook.ts:221-293`). Add two constants near `STEP_TIMEOUT_MS`:

```ts
const START_STEP_KEY = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
const FAILURES_EXIT_KEY = "pipeline-failuresExit.mmd::FAILURES_EXIT";
```

Add `let inFailureChain = false;` beside `let stepKey` / `let input`.

1. **Before each block runs** (top of the `while (true)` body, before `runStepScript`), when `inFailureChain` is false and the packet names an existing worktree:
   write `{ state: "running", block: stepKey, input, sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom, taskNumber, runId, projectRoot }` where `resumedFrom` is copied from the file already there (`readCheckpoint(worktree)?.resumedFrom ?? null`).
   A kill during the block leaves the checkpoint naming that block, so the resume runs it again (section 6 makes that safe).
   Because this write comes after the start-input check, a consumer block whose packet is bad never overwrites the prompt block's checkpoint. Resume then re-runs the prompt block and a fresh agent answers it.
2. **When a block routes to the failure chain** — right after `nextStepKey` is computed (line ~285) and before `stepKey = nextStepKey`:
   `if (nextStepKey === FAILURES_EXIT_KEY && !inFailureChain)` →
   write `{ state: "failed", block: stepKey, input, sourceLockHeld, exitType: String(stepRun.result.exitType ?? ""), exitNote: String(stepRun.result.exitNote ?? ""), resumedFrom, ...ids }` where `input` is still the input `stepKey` received, `resumedFrom` is copied as in step 1, and
   `sourceLockHeld = readSourceRepoLock(projectRoot)?.owner === buildLockOwner(runId, taskNumber)` (same test as `failuresExit/DOES_RUN_HOLD_SOURCE_LOCK_Q.ts:12`).
   Then `inFailureChain = true`. Nothing in the chain overwrites this record. When the packet has no worktree yet, skip the write and still set the flag.
3. **On STOP**: no write, no delete. Success removes the worktree; failure keeps it.
4. **Prompt stop**: no write. The checkpoint keeps naming the prompt block. A kill while the agent works on the prompt resumes by re-running the prompt block; its prompt then carries the section 5 notice.
5. Hook-level failures (`buildFailure` paths) write nothing. The `running` record from step 1 already names the block that failed.

`passId` in a step-1 write: when the file already there names the same `block` and the same `input`, keep its `passId` (that is a resume re-running the killed block); otherwise `randomUUID()`. The step-2 write copies the `passId` already in the file. So the re-run of a killed block sees the `passId` the killed run had, and every other block execution gets its own.
`worktree` for a write comes from `getPacketFromInput(input).worktree`.

## 3. When the hook resumes

At the top of `walkFromStep`, after the `packetFile` expansion and before the start-input check:

```ts
if (startStepKey === START_STEP_KEY) {
    const entry = findResumeEntry(Number(startPacket.taskNumber), String(startPacket.tasksFile));
    if (entry !== null) {
        return walkFromStep(entry.block, entry.input, invocation);
    }
}
```

`findResumeEntry(taskNumber, tasksFile): { block: string; input: string } | null` lives in the new file `scripts/tackle-tasks/shared/resumeRun.ts`; the hook imports it. It applies the table in section 0:
- row 1 and row 5: return null.
- row 2: `prepareResume(checkpoint)`, then `markCheckpointResumed(worktree, checkpoint)`, then return `{ block: checkpoint.block, input: checkpoint.input }`.
- row 3: return the merge-tail entry from the table.
- row 4: end the dead record as the table says, then return null.

`markCheckpointResumed` rewrites the file as `{ ...checkpoint, state: "running", resumedFrom: { block: checkpoint.block, exitType: checkpoint.exitType, exitNote: checkpoint.exitNote } }`. From then on every write in section 2 carries `resumedFrom` forward, so a prompt block anywhere later in the walk can read it.

`prepareResume(checkpoint)`, in this order:

1. `reopenTaskRun(taskNumber, runId, projectRoot)` — new function in `taskRunState.ts` (section 4). A `running` checkpoint from a crash finds the record still active; the function then changes nothing.
2. Read `readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktree))` (both from `scripts/prepareTasks.ts`, same call as `failuresExit/DOES_RUN_HOLD_LEASE_Q.ts:11`); throw `resume: worktree lease for task N names run X, not Y` when `owner === null` or `owner.runId !== runId`.
   No adopt call: the failure chain retains the lease under this same runId (`RELEASE_WORKTREE_LEASE.ts` F5), a crash never released it, and `adoptWorktreeLease` exists for a new run taking an ended run's lease, which is not this case.
3. When `checkpoint.sourceLockHeld`: `acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber))`; accept `status` `"acquired"` or `"already-held-by-me"`; otherwise throw naming `outcome.owner`. A crash inside the locked region left the lock held by this owner; `acquireSourceRepoLock` answers `already-held-by-me`, and a lock gone stale in the meantime is re-taken the normal way.

The `ran` list of the resumed walk starts with the entry block. The workflow file and `SkillBodyEmitter.ts` do not change.

## 4. `reopenTaskRun` in `scripts/tackle-tasks/shared/taskRunState.ts`

Place it after `endTaskRun` (line 624). Same lock and lookup pattern as `endTaskRun`:

```ts
export function reopenTaskRun(taskNumber: number, expectedRunId: string, projectRoot: string): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        const currentRecord = state.history[state.history.length - 1];
        if (currentRecord === undefined || currentRecord.runId !== expectedRunId) {
            throw new Error(`task ${taskNumber}'s newest run is not "${expectedRunId}"`);
        }
        if (state.active) return state;
        const nextRecord: TaskRunRecord = { ...currentRecord, endedAt: null, exitType: null, exitNote: null };
        const nextState: TaskRunState = { ...state, active: true, history: [...state.history.slice(0, -1), nextRecord] };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}
```

`commits`, `attempts`, `taskTests`, `fullSuite`, `modifiedFiles` stay as they were. An `attempts` counter that already hit 2 makes the same `ARE_2_*_DONE_Q` block exit again if the hand fix did not work. That is the intended stop.

## 5. Prompts in a resumed run

A resumed walk re-runs each prompt block it reaches, so the block builds its prompt string and rewrites its `.prompt.md` file from the current worktree. The packet file the old run left is not read again. What the fresh prompt lacks is the notice that the worktree already holds work.

New file `scripts/tackle-tasks/shared/resumedRunSection.ts`, one function, same style as `whatToReturn.ts`:

```ts
// Tells an agent the worktree already holds work from a run that stopped; "" when this run was never resumed.
export function resumedRunSection(repoRoot: string): string {
    const path = join(repoRoot, "plans", "checkpoint.json");
    if (!existsSync(path)) return "";
    const { resumedFrom } = JSON.parse(readFileSync(path, "utf8")) as { resumedFrom: { block: string; exitType: string; exitNote: string } | null };
    if (resumedFrom === null) return "";
    return `## RESUMED RUN

You are working in a resumed task worktree.
The previous run stopped at \`${resumedFrom.block}\` with exit type "${resumedFrom.exitType}": ${resumedFrom.exitNote}
The worktree already holds work from that run, and its commits are on the task branch.
Read the current state of every file you own before you change anything.
Do not redo work that is already done.`;
}
```

When the stop was a kill, not a failure exit, `exitType` and `exitNote` are `""`; the sentence then reads `with exit type "": ` — replace it with `The previous run was stopped at \`${block}\`.` when `exitType === ""`.

Call it in the five prompts an agent does work from, right after the `## WHAT YOU MAY EDIT` / owned-files section of each (the section is empty when there is nothing to say):
- `scripts/tackle-tasks/shared/planPrompt.ts` (PLAN_THE_TASK)
- `scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.ts`
- `scripts/tackle-tasks/fixImplementTaskTests/FIX_IMPLEMENT_TASK_TESTS.ts`
- `scripts/tackle-tasks/fixTheCodebaseForSuite/FIX_THE_CODEBASE_FOR_SUITE.ts`
- `scripts/tackle-tasks/shared/FixConflictsBodyEmitter.ts`

The two Codex spawn prompts (`CODEX_REVIEWS_PLAN.ts`, `CodexTestReviewBodyEmitter.ts`) only run a command against files as they are now; they get no notice.

## 6. Every block after CREATE_WORKTREE must survive a second run with the same input

A kill lands anywhere inside a block. The checkpoint names that block, so the resume runs it again from the same input. Each such block must then finish without throwing and without a second copy of its write. `greenBoxPolicy.ts` already names the mutating scripts; the checklist is every block that calls one of them, plus the two counters below.

Known one-shot writes to fix first:
- `MARK_TASK_INACTIVE_FAILURE` / `MARK_TASK_INACTIVE_SUCCESS` → `shared/markTaskInactive.ts` calls `endTaskRun`, which throws `no active run` on a second run. Change `markTaskInactive`: when `readTaskRunState` shows `active === false` and the newest record has `runId === input.runId` and `endedAt !== null`, return `{ active: false, endedAt }` without calling `endTaskRun`.
- Blocks that call `raiseAttemptCount` (`whatIsReviewVerdict/UPDATE_TASKS_JSON.ts:26`, `whatDidThePlannerReturn/WRITE_CLARIFY_REQUEST.ts:30`, `commitImplementationIfNeeded/AMEND_ENTRY_WITH_FAILING_TESTS.ts:12`, `runFullSuite/ARE_2_SUITE_FIXES_DONE_Q.ts:18`, `runFullSuite/ARE_2_MERGE_ATTEMPTS_DONE_Q.ts:17`, `rebase/ARE_2_CONFLICT_FIXES_DONE_Q.ts:26`) count one more on a second run. Make the count idempotent on the hook's `passId`:
  - `raiseAttemptCount(taskNumber, expectedRunId, counter, passId, projectRoot)` (`taskRunState.ts:556`): add `countedPasses?: Record<string, string[]>` to `TaskRunRecord`; when `newest.countedPasses?.[counter]` already holds `passId`, return the current count and write nothing; otherwise raise the count and append `passId` to that list.
  - Each of the six blocks reads `passId` with `readCheckpoint(packet.worktree)` from `shared/checkpoint.ts` and throws `<BOX>: no checkpoint in <worktree>` when the file is absent. All six run after CREATE_WORKTREE, so the file exists in a real run; their tests write one into the fixture worktree.

Already safe, no change: `COMMIT_*` (F2 in `commitTaskWork.ts`), `LOCK_SOURCE_REPO` (`already-held-by-me`), `CREATE_WORKTREE` (journal recovery in `createTaskWorktree.ts:174-185`), `TAKE_WORKTREE_LEASE` (same values written again), `RELEASE_SOURCE_LOCK` / `RELEASE_WORKTREE_LEASE` (release of an absent hold returns `released: false`).

For every other block on the checklist: add `test_<BOX>_runsTwiceWithTheSameInput` to its existing test file — run `main(input)` twice, assert the second call returns the same object and the tree and `tasks.json` are unchanged between the calls. Fix the block when the test is red. Do this block by block; do not batch.

## 7. Order of work (red → green per step)

### Step 1 — `reopenTaskRun`
File: `scripts/tackle-tasks/shared/taskRunState.test.ts` (add to the existing file).
- `test_reopenTaskRun_setsTheEndedRecordActiveAgain`: claim a task with runId R, `writeTaskExitNotes` "tests-red", `endTaskRun`; call `reopenTaskRun`; assert `active === true`, newest `endedAt === null`, `exitType === null`, `runId === R`, `commits` unchanged.
- `test_reopenTaskRun_refusesARunIdThatIsNotTheNewest`: assert it throws for runId "other".
- `test_reopenTaskRun_leavesAnAlreadyActiveRunAlone`: claim, do not end, reopen; assert state is equal.
Then write the function from section 4.

### Step 2 — `findResumeEntry` and `prepareResume`
File: `scripts/tackle-tasks/shared/resumeRun.test.ts` (new). Build the repo the way `commitTaskWork.test.ts` does (`makeSourceRepoWithSubmodule`, `createLinkedWorktree`, `seedTaskAndClaim`). One test per row of the section 0 table:
- `test_findResumeEntry_returnsNullForATaskThatIsNotInTasksJson` (row 1).
- `test_findResumeEntry_returnsTheCheckpointBlockAndInput` (row 2): set `run.worktree`, write the file, assert the entry and that the file now has `state: "running"` and `resumedFrom`.
- `test_findResumeEntry_resumesTheMergeTailAtBuildClosureNoteWhileActive` and `…AtArchiveTaskWhenInactive` (row 3): worktree folder removed, newest `exitType: "completed"`; assert block and the exact input string.
- `test_findResumeEntry_endsARunThatDiedBeforeAWorktreeAndReturnsNull` (row 4): assert `tasks.json` newest has `exitType: "agent-failed"`, `active === false`.
- `test_findResumeEntry_returnsNullWhenTheWorktreeIsGone` (row 5).
- `test_prepareResume_reopensTheRecordAndRetakesTheLock`: claim, take the lease and the source lock, run the failure bookkeeping (`writeTaskExitNotes`, `endTaskRun`, `releaseSourceRepoLock`; the lease stays, as F5 keeps it); call `prepareResume({ ...checkpoint, sourceLockHeld: true })`; assert active, `readSourceRepoLock(projectRoot).owner === buildLockOwner(runId, taskNumber)`.
- `test_prepareResume_acceptsALockThisRunStillHolds`: crash case, lock never released; assert no throw.
- `test_prepareResume_throwsWhenTheLeaseNamesAnotherRun`: overwrite the lease file with `{ runId: "other" }`; assert it throws.
- `test_prepareResume_throwsWhenAnotherRunHoldsTheSourceLock`.
Then write `scripts/tackle-tasks/shared/resumeRun.ts` from section 3.

### Step 3 — checkpoint writes in the hook
File: `tests/runStepHook.test.ts`. The fake steps from `configWith` echo their input; give each fake output a `worktree` key set to a temp folder and a `runId`, and extend `runHook` to return `readCheckpoint(worktree)`.
- `test_runStepHook_writesARunningCheckpointNamingThePromptBlock`: A(continue) → B(prompt); run `/run-step A {"taskNumber":7,"worktree":"<dir>","runId":"r1","projectRoot":"<dir>"}`; assert checkpoint `{ block: "…::B", state: "running", input: <A's output minus next> }`.
- `test_runStepHook_writesNoCheckpointBeforeAWorktreeExists`: same walk with `worktree: ""`; assert no file.
- `test_runStepHook_keepsTheFailedBlockInTheCheckpointThroughTheFailureChain`: config has diagram `pipeline-failuresExit.mmd` with FAILURES_EXIT(continue) → STOP(stop), and A(continue, next FAILURES_EXIT_KEY, output carrying `exitType: "tests-red"`, `exitNote: "n"`); run A; assert checkpoint `{ block: "…::A", state: "failed", exitType: "tests-red", input: <the start input> }` after STOP.
Then write section 2.

### Step 4 — resume redirect in the hook
- `test_runStepHook_resumesAtTheCheckpointBlockWhenTheStartBlockIsThePreamble`: write a temp `tasks.json` holding `[{ "taskNumber": 7, "run": { "active": true, "worktree": "<dir>", "leaseRunId": "r1", "history": [{ "runId": "r1", "startedAt": "t", "endedAt": null, "exitType": null, "exitNote": null, "modifiedFiles": [], "commits": [], "implementationNotesFile": null, "taskTests": null, "fullSuite": null }] } }]` plus a lease file naming `r1`; config has `pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK`(stop) and `x.mmd::X`(stop); pre-write `<dir>/plans/checkpoint.json` with `block: "x.mmd::X"`, `runId: "r1"`, `sourceLockHeld: false`; run `/run-step pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK {"taskNumber":7,"tasksFile":"<tasks.json>"}`; assert `ran` equals `["x.mmd::X"]`.
- `test_runStepHook_marksTheCheckpointResumedBeforeWalking`: same setup; after the run, assert the checkpoint has `state: "running"` and `resumedFrom.block === "x.mmd::X"`.
- `test_runStepHook_carriesResumedFromThroughLaterWrites`: resume into A(continue) → B(prompt); assert the checkpoint written for B still has the same `resumedFrom`.
- `test_runStepHook_keepsThePassIdWhenItRerunsTheCheckpointBlock`: resume into X; assert the checkpoint written before X keeps the pre-written `passId`.
- `test_runStepHook_givesEveryNewBlockExecutionItsOwnPassId`: A(continue) → B(prompt); assert B's checkpoint `passId` differs from the one written for A.
- `test_runStepHook_startStepKeyMatchesTheWorkflowsStartStep`: assert the hook's `START_STEP_KEY` equals `START_STEP` from `scripts/generateWorkflow.ts` (read the hook file with a regex, as the test file cannot import the hook's module without running it).
Then write section 3's hook edit.

### Step 5 — the resumed-run notice
File: `scripts/tackle-tasks/shared/resumedRunSection.test.ts` (new).
- `test_resumedRunSection_isEmptyWithoutACheckpoint`.
- `test_resumedRunSection_isEmptyWhenTheRunWasNeverResumed` (`resumedFrom: null`).
- `test_resumedRunSection_namesTheBlockAndExitOfTheStoppedRun`: pin the exact text above.
- `test_resumedRunSection_namesOnlyTheBlockAfterAKill` (`exitType: ""`).
Then write the function. Then, in `scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.test.ts`, add `test_implementTaskPrompt_carriesTheResumedRunNotice`: write a checkpoint with `resumedFrom` into the fixture worktree and assert the prompt contains `## RESUMED RUN`. Then add the call to the five prompts.

### Step 6 — second-run safety, block by block
1. `markTaskInactive`: `test_markTaskInactive_returnsTheSameAnswerOnASecondRun`.
2. `raiseAttemptCount` in `taskRunState.test.ts`: `test_raiseAttemptCount_countsAPassIdOnlyOnce` (same passId twice → 1), `test_raiseAttemptCount_countsEachNewPassId` (two passIds → 2), `test_raiseAttemptCount_recordsThePassIdItCounted`.
3. The six counter blocks, one at a time: `test_<BOX>_countsOnceWhenRunTwiceWithTheSameCheckpoint` and `test_<BOX>_throwsWithoutACheckpoint`; then the signature change at each call site.
4. Then walk the rest of the section 6 checklist.

### Step 7 — real kills
Ask the test session to run task 2 and kill the workflow at each of these points, then run `/tackle-tasks 2` and report `ran[0]`, whether the regenerated prompt holds `## RESUMED RUN`, `tasks.json` task 2 `run`, and the tree:
1. during PLAN_THE_TASK (agent working);
2. during IMPLEMENT_TASK (agent working, files half written);
3. during REBASE_ONTO_TARGET_BRANCH (source lock held);
4. after a `tests-red` failure exit, after fixing the test by hand;
5. during BUILD_CLOSURE_NOTE (worktree already removed);
6. during MARK_TASK_ACTIVE (before a worktree).

## 8. What this plan does not do
- No `resume` keyword, no block override argument.
- No reset of `attempts` counters; a resumed loop keeps the rounds it already spent.
- `IS_PREVIOUS_RUN_RESUMABLE_Q` and the rest of the preamble stay as they are; they still run for rows 1, 4 and 5.
- `run-log.md` is not parsed. It stays the human log.
- No checkpoint for the blocks before CREATE_WORKTREE; row 4 covers them.
