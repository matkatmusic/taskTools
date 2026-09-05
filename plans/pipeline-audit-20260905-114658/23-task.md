# Task 23 plan — hard block failures inside the failures-exit chain resume the cleanup, not the task work

Session task 23 (`/Users/matkatmusicllc/.claude/tasks/taskTools-86/23.json`), blocked by task 15,
related to task 16. Spec ("Missing critical task: hard block failures do not enter a durable
failure state" in `plans/pipeline-audit-codex-20260905-113523.md`):
`runStepHook.ts:336-359` returns `buildFailure()` for timeouts, non-zero exits, missing output, and
contract errors; `buildFailure()` (`runStepHook.ts:203-210`) only appends a log line and returns an
error object — it does not persist anything resumable. That is tolerable for a crash during normal
task work, because the worktree checkpoint (written at the top of the walk loop) already lets
resume retry the same box. It is **not** tolerable for a crash inside the failures-exit chain:
`inFailureChain` (set at `runStepHook.ts:407`) suppresses every later checkpoint write
(`runStepHook.ts:317`'s `!inFailureChain` guard), so the worktree checkpoint stays frozen at the
pre-failure block. If a later failures-exit box (e.g. `RELEASE_SOURCE_LOCK`) then crashes, the next
resume reads that frozen checkpoint and **re-runs the original task work from scratch**, instead of
continuing the tail — exactly the "worse" case the task's description calls out. Fix: reuse task
16's `tailCursor` (owned by `taskRunState.ts`, read with top priority by
`resumeRun.ts`'s row 0 — both already landed by task 16) so every box inside the tail persists
where it is, outside the worktree, and the tail's own terminal box clears it.

This plan does **not** make `buildFailure()` auto-enter `FAILURES_EXIT` for an ordinary task-work
crash outside any exit chain — that would require inferring what resources a box might be holding
from a bare non-zero exit, a materially larger and riskier change than what this task's own test
directive asks for ("inject a failure at each failures-exit box and prove the next invocation
continues cleanup instead of rerunning task work"). That directive is scoped to the tail; this plan
implements exactly that scope.

## Scope confirmation

- `scripts/runStepHook.ts` — read in full (504 lines). Depends on task 16 having already added
  `writeTailCursor` and `resumeRun.ts`'s row 0 (this plan does not redefine that record — it is the
  one persisted record task 16 introduced; this plan is purely a second writer of it).
  - Import line 15 today: `import { resetAttemptCounts } from "./tackle-tasks/shared/taskRunState.ts";`
    — extended to also import `writeTailCursor`.
  - Lines 306-333 today (`walkFromStep`'s loop body, top half):
    ```ts
        const boxesRun: string[] = [];
        let stepKey = startStepKey;
        let input = startInput;
        let inFailureChain = false;
        while (true) {
            const step = STEPS_BY_KEY.get(stepKey)!;
            const packet = getPacketFromInput(input);
            const worktree = typeof packet.worktree === "string" ? packet.worktree : "";
            const worktreeExists = worktree !== "" && existsSync(worktree);
            // A prompt block and its answer-consuming block checkpoint at the block that feeds the prompt, so resuming reproduces it.
            const answersAPrompt = startedFromPacketFile && boxesRun.length === 0;
            if (!inFailureChain && worktreeExists && !step.producesPrompt && !answersAPrompt) {
                const existing = readCheckpoint(worktree);
                writeCheckpoint(worktree, {
                    taskNumber: Number(packet.taskNumber),
                    passId: existing?.block === stepKey && existing?.input === input ? existing.passId : randomUUID(),
                    runId: String(packet.runId ?? ""),
                    projectRoot: String(packet.projectRoot ?? ""),
                    block: stepKey,
                    input,
                    state: "running",
                    sourceLockHeld: false,
                    exitType: "",
                    exitNote: "",
                    resumedFrom: existing?.resumedFrom ?? null,
                });
            }
            const stepRun = runStepScript(step, input, invocation);
    ```
    This `if (!inFailureChain && ...)` block is unchanged by this plan — it is the block that
    freezes at the pre-failure box, and that freeze is correct and still asserted by
    `tests/runStepHook.test.ts:937-955`
    (`test_runStepHook_keepsTheFailedBlockInTheCheckpointThroughTheFailureChain`) and
    `tests/runStepHook.test.ts:900-921`
    (`test_runStepHook_failsTheBlockAfterAPromptBackToTheBlockBeforeIt`). This plan adds a sibling
    write, gated on `inFailureChain` being true, immediately after this block and before
    `runStepScript` runs.
  - `walkFromStep` is recursive, and `let inFailureChain = false;` (line 309) is a fresh local on
    every call — confirmed live: the tailCursor resume path this plan relies on (`findResumeEntry`
    returning a `pipeline-failuresExit.mmd::X` block, then `return walkFromStep(entry.block,
    entry.input, invocation);` at line 299) starts a brand-new `walkFromStep` call whose loop begins
    with `inFailureChain = false`, exactly like a normal first-ever walk. Left as `false`, that
    resumed walk would both write a normal worktree checkpoint at line 317-332 for a box that is
    really mid-tail, and never write the new tail-cursor cursor this plan adds (its guard below is
    `if (inFailureChain)`), stranding the cursor at whatever box the *previous* process crashed on
    even after this one succeeds. Step 1 initializes `inFailureChain` from `startStepKey` itself
    (`stepKey.startsWith("pipeline-failuresExit.mmd::")`) rather than always `false`, so a walk that
    starts *inside* the tail is recognized as being inside it from its very first iteration — this
    is also correct for the ordinary (non-resume) top-level entry, since a fresh walk never starts
    at a box in `pipeline-failuresExit.mmd` except via this exact resume path or a worktree-checkpoint
    resume that (per the paragraph above) never resolves to one, because the checkpoint freezes at
    the pre-failure box the moment the chain is entered.
  - Lines 385-408 (the `FAILURES_EXIT_KEY` transition that sets `inFailureChain = true`) are
    unchanged — that is where the chain is entered and the pre-failure checkpoint is correctly
    frozen; this plan does not touch it.
  - `EXIT_DIAGRAMS`, `FAILURES_EXIT_KEY`, `SUCCESS_DIAGRAM` constants (lines 32, 49, 52) are
    read-only references confirming `pipeline-failuresExit.mmd` is the one diagram this plan
    instruments.
- `tests/runStepHook.test.ts` — read in full (1243 lines). Two existing tests construct a fake
  `pipeline-failuresExit.mmd` with `projectRoot: worktree` and **no** `tasks.json` anywhere under
  `worktree`: `test_runStepHook_failsTheBlockAfterAPromptBackToTheBlockBeforeIt` (lines 900-921) and
  `test_runStepHook_keepsTheFailedBlockInTheCheckpointThroughTheFailureChain` (lines 937-955). Once
  this plan makes the walk loop call `writeTailCursor(taskNumber, runId, ..., projectRoot)` for
  every box once `inFailureChain` is true, both tests will throw `"task 7 not found"` the moment
  they enter `FAILURES_EXIT`, because `writeTailCursor` (per task 16's implementation) requires a
  real task record. Both must be updated to seed one, using the exact literal-JSON style already
  proven at lines 961-972 (`test_runStepHook_resumesAtTheCheckpointBlockWhenTheStartBlockIsThePreamble`).
  `configWith` (lines 44-69) and `runHook` (lines 17-41) are read in full and reused as-is; they
  already support a per-test fake `steps.json` with arbitrary boxes/scripts, and the preamble-resume
  test at lines 958-986 is the exact template for driving a second, fresh `/run-step` invocation
  that resumes through `findResumeEntry`.
- `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.ts` — read in full (14 lines). Last
  real box before `STOP` in `scripts/steps.json`'s `pipeline-failuresExit.mmd` array
  (`RELEASE_SOURCE_LOCK -> REPORT_EXIT_TYPE_AND_NOTE -> STOP`, and
  `DOES_RUN_HOLD_SOURCE_LOCK_Q -> REPORT_EXIT_TYPE_AND_NOTE` on the "lock not held" branch — both
  predecessors converge here, so this is the single place the whole chain's tail cursor can be
  cleared). Currently just echoes the packet:
  ```ts
  export function main(input: string): Record<string, unknown> {
      const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
      return { ...packet, box: "REPORT_EXIT_TYPE_AND_NOTE", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
  }
  ```
- `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.test.ts` — read in full (22 lines).
  Its one existing test uses `projectRoot: "/repo"`, a path that does not exist on disk. Once
  `main()` calls `writeTailCursor`, this throws `"task 169 not found"` immediately (no
  `resolveTaskFiles("/repo")` ever finds a task record). This test must be rewritten against a real,
  seeded `projectRoot`.
- `scripts/tackle-tasks/failuresExit/_packet.ts` — read-only reference; `EntryPacket` already
  carries `taskNumber, runId, projectRoot` on every box between `FAILURES_EXIT` and
  `REPORT_EXIT_TYPE_AND_NOTE`, confirming the walk-loop write (which reads these three fields off
  the generic `packet` object, not off a box-specific type) is well-typed for every box in the
  chain.
- `scripts/tackle-tasks/shared/taskRunState.ts` (`writeTailCursor`) and
  `scripts/tackle-tasks/shared/resumeRun.ts` (row 0) — read-only for this plan; both already exist
  once task 16 lands. This plan owns no new persisted-record logic, only new call sites.

## Steps

### Step 1 — the walk loop persists a tail cursor for every box once inside the failures-exit chain (RED, then GREEN)

First, update the two existing tests so they keep passing once the new write requires a real task
record — this is not new test *behavior*, it is a fixture fix, so do this before writing the new
red test:

1. In `tests/runStepHook.test.ts`, at the top of
   `test_runStepHook_failsTheBlockAfterAPromptBackToTheBlockBeforeIt` (line 901, right after
   `mkdirSync(join(worktree, ".git"));`), add:
   ```ts
       writeFileSync(join(worktree, "tasks.json"), JSON.stringify([{
           taskNumber: 7,
           run: {
               active: true, worktree: null, leaseRunId: null,
               history: [{
                   runId: "r1", startedAt: "t", endedAt: null, exitType: null, exitNote: null,
                   modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
               }],
           },
       }]));
   ```
2. Add the identical block at the top of
   `test_runStepHook_keepsTheFailedBlockInTheCheckpointThroughTheFailureChain` (line 938, right
   after its own `mkdirSync(join(worktree, ".git"));`).

These two tests' own assertions are about the frozen worktree checkpoint, not about
`tailCursor`, so no other change to them is needed — run
`npm test -- tests/runStepHook.test.ts` now and confirm both still pass unchanged (this is a
pure fixture addition, not yet exercising new behavior).

Now add the new test, `test_runStepHook_advancesTheTailCursorAcrossMultipleBoxesAfterAResumedBoxSucceeds`.
It proves three things together: resume lands on the box that actually crashed (not back at the
original task-work box), that box can then succeed on retry, and the walk keeps advancing the
cursor through the box(es) after it in that same pass — not just that the first resumed box was
chosen. `MIDDLE`'s script crashes on its first invocation and succeeds on the second (a marker
file on disk distinguishes the two), standing in for any real failures-exit box that fails once and
is safe to retry (e.g. `RELEASE_SOURCE_LOCK`, whose own release call reproves ownership and is a
no-op if already released):
```ts
test("test_runStepHook_advancesTheTailCursorAcrossMultipleBoxesAfterAResumedBoxSucceeds", () => {
    // Setup: a worktree, a separate tasks.json naming task 7 with an active run "r1", and a
    // lease so a checkpoint-based resume (the pre-fix behavior) could also legally run.
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    mkdirSync(join(worktree, ".git"));
    const tasksFile = join(mkdtempSync(join(tmpdir(), "run-step-tasks-")), "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([{
        taskNumber: 7,
        run: {
            active: true, worktree: null, leaseRunId: null,
            history: [{
                runId: "r1", startedAt: "t", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(`${worktree}.lease`, JSON.stringify({ pid: process.pid, runId: "r1" }));

    // Setup: A fails into the tail; FAILURES_EXIT runs cleanly and echoes the packet fields forward
    // (matching the real FAILURES_EXIT.ts's `{...packet, box, scriptSignal}` spread — a plain
    // writeStep() canned result does not echo its input, so this step's result names them itself).
    // MIDDLE crashes exactly once, via a marker file, then succeeds; LAST is an ordinary box after it.
    const configFile = configWith((writeStep, folder) => {
        const markerPath = join(folder, "middle-ran-once");
        const middleScriptPath = join(folder, "MIDDLE.ts");
        writeFileSync(middleScriptPath, [
            'import { existsSync, writeFileSync } from "node:fs";',
            `const marker = ${JSON.stringify(markerPath)};`,
            'if (!existsSync(marker)) { writeFileSync(marker, "1"); process.exit(1); }',
            `console.log(JSON.stringify({ box: "MIDDLE", scriptSignal: "continue", worktree: ${JSON.stringify(worktree)}, runId: "r1", taskNumber: 7, projectRoot: ${JSON.stringify(dirname(tasksFile))} }));`,
        ].join("\n"));
        return {
            [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
            "one.mmd": [
                { box: "A", script: writeStep("A", { scriptSignal: "continue", next: FAILURES_EXIT_KEY, exitType: "run-failed", exitNote: "n", worktree, runId: "r1", taskNumber: 7, projectRoot: dirname(tasksFile) }), next: [FAILURES_EXIT_KEY] },
            ],
            "pipeline-failuresExit.mmd": [
                { box: "FAILURES_EXIT", script: writeStep("FAILURES_EXIT", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: dirname(tasksFile) }), next: ["MIDDLE"] },
                { box: "MIDDLE", script: middleScriptPath, next: ["LAST"] },
                { box: "LAST", script: writeStep("LAST", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: dirname(tasksFile) }), next: ["STOP"] },
                { box: "STOP", script: writeStep("STOP", { scriptSignal: "stop" }), next: [] },
            ],
        };
    });
    const startInput = JSON.stringify({ taskNumber: 7, worktree, runId: "r1", projectRoot: dirname(tasksFile) });

    // Test action, pass 1: A routes into the tail; MIDDLE crashes on its first run.
    const first = runHook(`/run-step A ${startInput}`, configFile);
    assert.equal(first.result.ok, false);

    // Test action, pass 2: a fresh invocation starting at the preamble.
    const second = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile);

    // Verification: resume lands on MIDDLE (not back at A), MIDDLE now succeeds, and the walk keeps
    // going through LAST and STOP in the same pass — proving the cursor mechanism (and the checkpoint
    // suppression that goes with it) stays correctly engaged for every box after the resumed one.
    assert.equal(second.result.ok, true);
    assert.deepEqual(second.result.ran, [
        "pipeline-failuresExit.mmd::MIDDLE", "pipeline-failuresExit.mmd::LAST", "pipeline-failuresExit.mmd::STOP",
    ]);
});
```
Before the production fix, this fails two ways in sequence as fixes land: with no `tailCursor` ever
written and `inFailureChain` untouched, `findResumeEntry` falls through row 0, finds the worktree
checkpoint frozen at `one.mmd::A` (row 2), and `second.result.ran[0]` is `"one.mmd::A"`. Once the
cursor write is added but `inFailureChain` still always starts `false`, resume does land on `MIDDLE`
first — but the loop's line 317 checkpoint-write block fires for it (since `inFailureChain` reads
`false` at the top of this fresh walk), and no cursor write follows it into `LAST`, so a failure
mid-`LAST` would incorrectly resume at the frozen `MIDDLE` checkpoint instead — this test's
`deepEqual` on the full `ran` array plus `ok: true` catches that this pass truly walked all three
boxes in one continuous, correctly-flagged tail, not just that the first one matched.

Production change in `scripts/runStepHook.ts`:
1. Extend the import at line 15:
   ```ts
   import { resetAttemptCounts, writeTailCursor } from "./tackle-tasks/shared/taskRunState.ts";
   ```
2. Replace line 309's unconditional `let inFailureChain = false;` with a value derived from where
   this walk starts, so a walk that begins *inside* the tail (via `findResumeEntry`'s row 0) is
   already flagged as such from its first iteration:
   ```ts
       let inFailureChain = startStepKey.startsWith("pipeline-failuresExit.mmd::");
   ```
   This is a one-line change to an existing declaration, not a new parameter: every other call to
   `walkFromStep` (the top-level entry, the packet-file/prompt-answer path, the start-at-block path)
   still starts with a `startStepKey` outside `pipeline-failuresExit.mmd`, so `inFailureChain` is
   still `false` for all of them, unchanged.
3. Immediately after the existing `if (!inFailureChain && worktreeExists && ...)` checkpoint block
   (i.e. right after its closing `}` on line 332) and before `const stepRun =
   runStepScript(step, input, invocation);` (line 333), add:
   ```ts
           // Once inside an exit tail, the worktree checkpoint above stays frozen at the box that
           // entered it (inFailureChain is true here, so it never runs again). This durable cursor
           // is what a crash of a LATER tail box — including a resumed one — resumes from instead.
           if (inFailureChain) {
               writeTailCursor(Number(packet.taskNumber), String(packet.runId ?? ""), { block: stepKey, input }, String(packet.projectRoot ?? ""));
           }
   ```

Run `npm test -- tests/runStepHook.test.ts`: the new test passes, and the two updated tests still
pass (their assertions only inspect the worktree checkpoint, which this change never touches — both
of them start their second `runHook` call at a box outside `pipeline-failuresExit.mmd`, or don't
make a second call at all).

### Step 2 — the tail's terminal box clears the cursor (RED, then GREEN)

First, rewrite `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.test.ts` so its
existing test uses a real, seeded `projectRoot` instead of the fictitious `"/repo"`, then add a
second test proving the clear:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./REPORT_EXIT_TYPE_AND_NOTE.ts";
import { claimTask, readTaskRunState, writeTailCursor } from "../shared/taskRunState.ts";

function makeProjectRootWithClaimedTask(taskNumber: number, runId: string): string {
    const root = mkdtempSync(join(tmpdir(), "reportExitTypeAndNote-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber, title: "t" }]));
    claimTask(taskNumber, runId, root);
    return root;
}

test("test_REPORT_EXIT_TYPE_AND_NOTE_reportsTheRunsExitTypeAndNote", () => {
    const projectRoot = makeProjectRootWithClaimedTask(169, "run-a");
    const packet = {
        taskNumber: 169, runId: "run-a", projectRoot, worktree: `${projectRoot}/.worktrees/task-169`,
        branch: "task-169", exitType: "partially-published", exitNote: "boom",
        publicationState: "SOME LANDED", modifiedFiles: [], next: "REPORT_EXIT_TYPE_AND_NOTE",
        leaseReleased: true, leaseRetained: false,
        lockReleased: true, active: false, endedAt: "2026-08-23T12:00:00-07:00",
    };

    const output = main(JSON.stringify(packet));

    assert.equal(output.box, "REPORT_EXIT_TYPE_AND_NOTE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.exitType, "partially-published");
    assert.equal(output.exitNote, "boom");
});

test("test_REPORT_EXIT_TYPE_AND_NOTE_clearsTheTailCursor", () => {
    // Setup: a claimed task with a tail cursor left over from an earlier box in the chain.
    const projectRoot = makeProjectRootWithClaimedTask(170, "run-b");
    writeTailCursor(170, "run-b", { block: "pipeline-failuresExit.mmd::RELEASE_SOURCE_LOCK", input: "{}" }, projectRoot);
    const packet = {
        taskNumber: 170, runId: "run-b", projectRoot, worktree: `${projectRoot}/.worktrees/task-170`,
        branch: "task-170", exitType: "tests-red", exitNote: "n",
        publicationState: "NONE LANDED", modifiedFiles: [], next: "REPORT_EXIT_TYPE_AND_NOTE",
        leaseReleased: true, leaseRetained: false,
        lockReleased: true, active: false, endedAt: "2026-08-23T12:00:00-07:00",
    };

    // Test action: run this, the chain's terminal box.
    main(JSON.stringify(packet));

    // Verification: the tail cursor is gone, so a future resume of this task never lands back in the tail.
    assert.equal(readTaskRunState(170, projectRoot).history[0].tailCursor, null);
});
```
The first test's expected values are unchanged from today — only its fixture (`projectRoot`) is
new, per the "when a design change makes an old test wrong, update it and say why" rule: it was
wrong the moment `main()` needed a resolvable task record, which it does starting with this step.

This fails (RED): `main()` does not call `writeTailCursor` yet, so the second test's
`tailCursor` stays `{block: "...RELEASE_SOURCE_LOCK", input: "{}"}` instead of `null`.

Production change in `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.ts`:
```ts
// REPORT_EXIT_TYPE_AND_NOTE, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { writeTailCursor } from "../shared/taskRunState.ts";
import type { EntryPacket } from "./_packet.ts";

// No underlying old function: this box only reports what earlier boxes already produced.
export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    // The chain's one exit: clear the tail cursor so a future resume never lands back in it.
    writeTailCursor(packet.taskNumber, packet.runId, null, packet.projectRoot);
    return { ...packet, box: "REPORT_EXIT_TYPE_AND_NOTE", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
```

Run `npm test -- scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.test.ts`: both tests
pass.

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

## Note for the implementer: ordering against tasks 15 and 16

This plan's `resumeRun.ts` row 0 and `taskRunState.ts`'s `tailCursor` field/`writeTailCursor`
function are the same objects task 16 introduces — do not redefine them here. Implement task 15,
then task 16, then this task, in that order; if this task somehow lands first in a worktree that
does not yet have task 16's changes, stop and implement task 16's Steps 1-3 first (the `tailCursor`
field, `writeTailCursor`, and `findResumeEntry`'s row 0) — this task only adds new *callers* of
that machinery, in `runStepHook.ts`'s walk loop and in `REPORT_EXIT_TYPE_AND_NOTE.ts`.
