# Task 23 plan — hard block failures reach the failures-exit chain, not a dead retry loop

Session task 23 (`/Users/matkatmusicllc/.claude/tasks/taskTools-86/23.json`), blocked by task 15,
related to task 16. Spec ("Missing critical task: hard block failures do not enter a durable
failure state" in `plans/pipeline-audit-codex-20260905-113523.md`): every hard block failure after
`MARK_TASK_ACTIVE` (a script that times out, exits non-zero, prints no result, prints an unknown
`scriptSignal`, or breaks its output contract) must either route into `pipeline-failuresExit.mmd`
(so the lock and lease get released and the exit type gets written) or leave a precise resumable
cleanup state — never just a checkpoint that retries the same doomed box forever.

**Current state, re-verified live just before writing this plan** (another session is actively
editing this repo; every line cited below was re-read from disk immediately before citing it):
the *tail-cursor* mechanism this plan depends on is already implemented and staged:
- `TaskRunRecord.tailCursor` and `writeTailCursor` exist in
  `scripts/tackle-tasks/shared/taskRunState.ts` (lines 78-83, 560-587 in the current file).
- `resumeRun.ts`'s `findResumeEntry` already has row 0 (lines 19-21): `if (newest !== null &&
  newest.tailCursor) { return { block: newest.tailCursor.block, input: newest.tailCursor.input }; }`,
  ahead of the worktree-checkpoint check.
- `scripts/runStepHook.ts`'s `walkFromStep` already derives `inFailureChain` from where the walk
  starts (line 342: `let inFailureChain = startStepKey.startsWith("pipeline-failuresExit.mmd::");`,
  not a hardcoded `false`) and already writes the tail cursor for every box once inside the tail
  (lines 366-371, immediately before `runStepScript` runs at line 372):
  ```ts
          // Once inside an exit tail, the worktree checkpoint above stays frozen at the box that
          // entered it (inFailureChain is true here, so it never runs again). This durable cursor
          // is what a crash of a LATER tail box — including a resumed one — resumes from instead.
          if (inFailureChain) {
              writeTailCursor(Number(packet.taskNumber), String(packet.runId ?? ""), { block: stepKey, input }, String(packet.projectRoot ?? ""));
          }
  ```
- `tests/runStepHook.test.ts`'s two pre-existing failure-chain tests
  (`test_runStepHook_failsTheBlockAfterAPromptBackToTheBlockBeforeIt`,
  `test_runStepHook_keepsTheFailedBlockInTheCheckpointThroughTheFailureChain`) already seed a
  `tasks.json` so `writeTailCursor` has a real task record to write against.

None of that is this plan's work to redo. What is **not yet implemented**, confirmed live just now:
- `buildFailure` (`scripts/runStepHook.ts:229-236`) still only logs and returns
  `{ ok: false, ran, errors, outcome: null, report }` — an *ordinary* task-work box that hard-fails
  (never having reached a decision box that explicitly names `FAILURES_EXIT_KEY`) still gets nothing
  but the frozen retry-same-box checkpoint. This is the gap this plan closes.
- `"block-failed"` is not a member of `TaskExitType` (`scripts/tackle-tasks/shared/taskRunState.ts:10-14`)
  or of `EXIT_TYPES` (`scripts/tackle-tasks/shared/writeTaskExitNotes.ts:6-11`).
- `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.ts` still just echoes its packet
  (confirmed live, 15 lines, unchanged) — the chain's terminal box never clears the tail cursor it
  (or `buildFailure`) leaves behind.
- No test proves the walk keeps advancing the cursor across more than one box in a single resumed
  pass, and no test injects a failure at each real `pipeline-failuresExit.mmd` box.

## Scope confirmation

- `scripts/runStepHook.ts` — every `buildFailure` call site, re-grepped live just now:
  ```
  229:function buildFailure(boxesRun: string[], errors: string[]): HookOutput {
  299:            return buildFailure([], [`packet file ${startPacket.packetFile} does not exist`]);
  303:            return buildFailure([], [`packet file ${startPacket.packetFile} is empty`]);
  337:        return buildFailure([], [`${startStepKey} input breaks its contract`, ...startInputMismatches]);
  378:            return buildFailure(boxesRun, [`${stepKey} ${why}`, stepRun.stdout]);
  381:            return buildFailure(boxesRun, [`${stepKey} printed no result object`, stepRun.stdout]);
  387:            return buildFailure(boxesRun, [`${stepKey} scriptSignal must be one of ${knownList}, not ${JSON.stringify(stepRun.result.scriptSignal)}`]);
  391:            return buildFailure(boxesRun, [`${stepKey} is marked returns_a_prompt but printed scriptSignal ${JSON.stringify(scriptSignal)}`]);
  394:            return buildFailure(boxesRun, [`${stepKey} printed scriptSignal "prompt" but is not marked returns_a_prompt in its diagram`]);
  398:            return buildFailure(boxesRun, [`${stepKey} output breaks its contract`, ...contractMismatches]);
  408:            return buildFailure(boxesRun, [`${stepKey} has an empty next; say where it goes next in steps.json`]);
  415:            return buildFailure(boxesRun, [`${stepKey} points at ${step.next.join(", ")}; its output must name one in next`]);
  418:            return buildFailure(boxesRun, [`${stepKey} next ${JSON.stringify(chosenNextBox)} is not one of ${step.next.join(", ")}`]);
  422:            return buildFailure(boxesRun, [`next box ${nextStepKey} is not in the config`]);
  537:    injectResult(buildFailure([], [`no block named ${startBoxId || "<missing>"}; known: ${knownKeys}`]));
  542:    injectResult(buildFailure([], [why]));
  ```
  Lines 378-422 (10 sites) sit inside the `while (true)` loop, where `packet` (from line 345) and
  `inFailureChain` (from line 342) are already live locals — these ten gain a third argument. Line
  337 sits just before the loop, with `startPacket` (line 293) already parsed and no possibility of
  already being in the tail — it gains `{ packet: startPacket, inFailureChain: false }`. Lines 299,
  303, 537, 542 have no resolvable task context at all (a missing/empty packet file, or a box name
  that matched nothing anywhere) and are left exactly as they are.
  `FAILURES_EXIT_KEY` (line 74: `"pipeline-failuresExit.mmd::FAILURES_EXIT"`) is the literal this
  plan routes into; `packetsDirectory()` (line 70) and `writeJsonAtomically` (imported line 11) are
  the existing helpers `buildSuccess` (lines 277-288) already uses to write a payload file, reused
  here rather than inventing a second payload convention.
  Import line 17 today: `import { resetAttemptCounts, writeTailCursor } from
  "./tackle-tasks/shared/taskRunState.ts";` — extended to add `readTaskRunState`.
- `scripts/tackle-tasks/shared/taskRunState.ts:10-14` — the `TaskExitType` union, read live, ends
  `| "partially-published" | "not-resumable";` with no `"block-failed"`.
- `scripts/tackle-tasks/shared/writeTaskExitNotes.ts:6-11` — `EXIT_TYPES`, read live, is the runtime
  guard `writeTaskExitNotes` checks (`writeTaskExitNotes.ts:29-31`) before writing any exit type;
  `WRITE_EXIT_TYPE_AND_NOTE.ts:9-14` calls `writeTaskExitNotes` with `packet.exitType` taken
  **directly** from the incoming packet (not recomputed), so a `"block-failed"` packet reaching that
  box without this array's update throws `unknown exit type "block-failed"` instead of completing
  the chain.
- `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.ts` — read live in full (15 lines,
  unchanged from prior research): last real box before `STOP` in `scripts/steps.json`'s
  `pipeline-failuresExit.mmd` array (`RELEASE_SOURCE_LOCK -> REPORT_EXIT_TYPE_AND_NOTE -> STOP`, and
  `DOES_RUN_HOLD_SOURCE_LOCK_Q -> REPORT_EXIT_TYPE_AND_NOTE` on the "lock not held" branch converge
  here too), currently just `{ ...packet, box: "REPORT_EXIT_TYPE_AND_NOTE", scriptSignal:
  SCRIPT_SIGNAL.CONTINUE }`.
- `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.test.ts` — read live in full (21
  lines, unchanged): its one test uses `projectRoot: "/repo"`, a path that resolves to no task
  record. Once `main()` calls `writeTailCursor`, this throws before returning. Rewritten below
  against a real, claimed `projectRoot`.
- `scripts/tackle-tasks/failuresExit/_packet.ts` — `EntryPacket` already carries `taskNumber, runId,
  projectRoot, worktree, branch, exitType, exitNote` on every box between `FAILURES_EXIT` and
  `REPORT_EXIT_TYPE_AND_NOTE`; the packet `buildFailure` constructs below matches this shape exactly
  so it satisfies `FAILURES_EXIT`'s own input contract on the resumed pass.
- `tests/runStepHook.test.ts` — read live in full (1484 lines now; grew since prior research because
  the other session added unrelated tests for other tasks). `FAILURES_EXIT_KEY`,
  `[PREAMBLE_DIAGRAM, PREAMBLE_BOX]`, `configWith`, `runHook`, and the two now-fixture-seeded
  failure-chain tests are all present exactly as previously read; nothing here conflicts with this
  plan's additions.
- `scripts/steps.json`'s `pipeline-failuresExit.mmd` array and `scripts/tackle-tasks/failuresExit/fixtures/{setup.sh,tasks.json}`
  — read live; the fixture seeds three active, claimed tasks (900001/900002/900003) and every real
  box's `<BOX>.template.json` already carries a realistic `input` matching one of them, with
  `{{PROJECT_ROOT}}` placeholders. `tests/stepTemplates.test.ts` (read in full) already spawns every
  one of these boxes' real scripts against this exact fixture on every `npm test` run, and separately
  proves every box's real output satisfies the next real box's real input contract
  (`test_stepEdge_*_agreesOnTheShape`) — this plan's table-driven test (Step 4) leans on both proofs
  rather than re-deriving them, and runs against an **isolated copy** of the fixture (not the shared
  in-place one) specifically because `node --test` can run test files concurrently and
  `tests/stepTemplates.test.ts` mutates that same shared fixture on every run.

## Steps

### Step 1 — `"block-failed"` becomes a known exit type

`scripts/tackle-tasks/shared/writeTaskExitNotes.test.ts` already exists (read live) and already has
this exact shape of test for another exit type,
`test_writeTaskExitNotes_acceptsNotResumable` — an active run, `writeTaskExitNotes` called directly
(not via the CLI), asserting the output and the persisted `exitType`. Add a sibling immediately
after it, `test_writeTaskExitNotes_acceptsBlockFailed`, reusing the file's own
`makeProjectRootWithTasks` and `endedRunRecord` helpers exactly as that test does:
```ts
test("test_writeTaskExitNotes_acceptsBlockFailed", () => {
    // Scenario: buildFailure routes an active task's hard failure into the tail; the writer must
    // record the new exit type, not throw.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [endedRunRecord({ endedAt: null, exitType: null, exitNote: null })] },
    }]);

    const output = writeTaskExitNotes({ taskNumber: 1, runId: "run-old", projectRoot: root, exitType: "block-failed", exitNote: "one.mmd::A exited 1" });

    assert.deepEqual(output, { exitType: "block-failed", exitNote: "one.mmd::A exited 1" });
    assert.equal(readTaskRunState(1, root).history[0].exitType, "block-failed");
});
```

This fails (RED): `EXIT_TYPES` does not include `"block-failed"`, so `writeTaskExitNotes` throws.

Production change:
1. `scripts/tackle-tasks/shared/taskRunState.ts:10-14` — add the new member:
   ```ts
   export type TaskExitType =
       | "completed" | "invalid-number" | "already-active" | "blocked"
       | "plan-scrapped" | "tests-red" | "tests-flagged" | "suite-red"
       | "rebase-stuck" | "merge-failed" | "fence-violation" | "run-failed"
       | "clarify-stuck" | "agent-failed" | "partially-published" | "not-resumable"
       | "block-failed";
   ```
2. `scripts/tackle-tasks/shared/writeTaskExitNotes.ts:6-11` — add the same literal:
   ```ts
   const EXIT_TYPES: readonly TaskExitType[] = [
       "completed", "invalid-number", "already-active", "blocked",
       "plan-scrapped", "tests-red", "tests-flagged", "suite-red",
       "rebase-stuck", "merge-failed", "fence-violation", "run-failed",
       "clarify-stuck", "agent-failed", "partially-published", "not-resumable",
       "block-failed",
   ];
   ```

Run `npm test -- scripts/tackle-tasks/shared/writeTaskExitNotes.test.ts`: it passes.

### Step 2 — `buildFailure` routes an active task's hard failure into `FAILURES_EXIT`

Test name: `test_runStepHook_routesAnOrdinaryHardFailureIntoFailuresExitOnceTheTaskIsActive`, added
to `tests/runStepHook.test.ts` near the other failure-chain tests:
```ts
test("test_runStepHook_routesAnOrdinaryHardFailureIntoFailuresExitOnceTheTaskIsActive", () => {
    // Setup: a worktree and a separate tasks.json naming task 7 with an active run "r1" — the
    // "past MARK_TASK_ACTIVE" state this routing only applies once inside.
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

    // Setup: A crashes outright — no decision box ever names FAILURES_EXIT_KEY.
    const configFile = configWith((writeStep, folder) => {
        const crashScriptPath = join(folder, "A-crash.ts");
        writeFileSync(crashScriptPath, "process.exit(1);\n");
        return {
            [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
            "one.mmd": [
                { box: "A", script: crashScriptPath, next: ["B"] },
                { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
            ],
            "pipeline-failuresExit.mmd": [{ box: "FAILURES_EXIT", script: writeStep("FAILURES_EXIT", { scriptSignal: "stop" }), next: [] }],
        };
    });
    const startInput = JSON.stringify({ taskNumber: 7, worktree, runId: "r1", branch: "task-7", projectRoot: dirname(tasksFile) });

    // Test action, pass 1: A crashes.
    const first = runHook(`/run-step A ${startInput}`, configFile);

    // Verification: the failure is still reported, but its outcome now names the failures-exit
    // block, and a durable tail cursor is left for the next invocation to pick up.
    assert.equal(first.result.ok, false);
    assert.equal(first.result.outcome?.next, FAILURES_EXIT_KEY);
    const tailCursor = readTaskRunState(7, dirname(tasksFile)).history[0].tailCursor;
    assert.equal(tailCursor?.block, FAILURES_EXIT_KEY);
    const cursorPacket = JSON.parse(tailCursor!.input);
    assert.equal(cursorPacket.exitType, "block-failed");
    assert.match(cursorPacket.exitNote, /A/);

    // Test action, pass 2: a fresh invocation starting at the preamble resumes into the tail.
    const second = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile);
    assert.equal(second.result.ok, true);
    assert.deepEqual(second.result.ran, [FAILURES_EXIT_KEY]);
});
```
Add `readTaskRunState` to a new import: `import { readTaskRunState } from
"../scripts/tackle-tasks/shared/taskRunState.ts";`.

This fails (RED): `buildFailure` today always returns `outcome: null`, so `first.result.outcome` is
`null` and there is no tail cursor to read.

Production change in `scripts/runStepHook.ts`:
1. Extend the import at line 17:
   ```ts
   import { readTaskRunState, resetAttemptCounts, writeTailCursor } from "./tackle-tasks/shared/taskRunState.ts";
   ```
2. Replace `buildFailure` (lines 229-236):
   ```ts
   // A walk that could not finish has no outcome to report on its own — unless a live, active task
   // can absorb it into the failures-exit chain instead of leaving a checkpoint that retries the
   // same doomed box forever.
   function buildFailure(
       boxesRun: string[],
       errors: string[],
       context: { packet: Record<string, unknown>; inFailureChain: boolean } = { packet: {}, inFailureChain: false },
   ): HookOutput {
       mkdirSync(dirname(logFile()), { recursive: true });
       const runLogEntries = existsSync(logFile()) ? readJsonFile(logFile()) as unknown[] : [];
       runLogEntries.push({ block: "FAILURE", invocation, ran: boxesRun, errors });
       writeJsonAtomically(logFile(), runLogEntries);
       const report = `The workflow failed to complete successfully: ${errors.join("\n")}\nSee ${runDirectory} for specific inputs and outputs of each run-step block's execution.`;
       const worktree = typeof context.packet.worktree === "string" ? context.packet.worktree : "";
       if (!context.inFailureChain) {
           if (worktree !== "" && existsSync(worktree)) {
               const taskNumber = Number(context.packet.taskNumber);
               const runId = String(context.packet.runId ?? "");
               const projectRoot = String(context.packet.projectRoot ?? "");
               if (readTaskRunState(taskNumber, projectRoot).active) {
                   const failingPacket = {
                       box: "FAILURES_EXIT", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
                       taskNumber, runId, projectRoot, worktree,
                       branch: String(context.packet.branch ?? ""),
                       exitType: "block-failed", exitNote: errors[0] ?? "",
                   };
                   const input = JSON.stringify(failingPacket);
                   writeTailCursor(taskNumber, runId, { block: FAILURES_EXIT_KEY, input }, projectRoot);
                   const payload = join(packetsDirectory(), `FAILURES_EXIT-${process.pid}.json`);
                   mkdirSync(dirname(payload), { recursive: true });
                   writeJsonAtomically(payload, failingPacket);
                   return { ok: false, ran: boxesRun, errors, outcome: { next: FAILURES_EXIT_KEY, payload }, report };
               }
           }
       }
       return { ok: false, ran: boxesRun, errors, outcome: null, report };
   }
   ```
   Two nested single-condition `if`s (worktree exists, then task active), matching the
   single-condition-branching rule; no `try`/`catch` — `readTaskRunState` throwing (e.g. the task
   record genuinely does not exist) is a loud, correct failure the top-level
   `uncaughtException` handler (lines 21-30) already reports.
3. Update the ten in-loop call sites (lines 378, 381, 387, 391, 394, 398, 408, 415, 418, 422) to
   pass the loop's own live locals as a third argument, e.g. line 378 becomes:
   ```ts
               return buildFailure(boxesRun, [`${stepKey} ${why}`, stepRun.stdout], { packet, inFailureChain });
   ```
   and identically `, { packet, inFailureChain }` appended to the other nine argument lists at 381,
   387, 391, 394, 398, 408, 415, 418, 422 — no other change to any of those lines.
4. Update line 337 (before the loop, where `startPacket` and not yet any `inFailureChain` exist):
   ```ts
           return buildFailure([], [`${startStepKey} input breaks its contract`, ...startInputMismatches], { packet: startPacket, inFailureChain: false });
   ```
5. Leave lines 299, 303, 537, 542 exactly as they are — no packet, no task context, nothing to route.

Run `npm test -- tests/runStepHook.test.ts`: the new test passes, and no pre-existing test in the
file exercises a hard failure with both a real worktree and an active task via the ten updated call
sites without also expecting `outcome: null` — confirm this by running the whole file and checking
for regressions in the existing `test_runStepHook_stopsWhenAStepExitsNonZero` and
`test_runStepHook_failsWhenABlockBreaksItsOutputContract`-style tests (they use fake worktrees that
either don't exist or aren't linked to a claimed task, so `worktreeExists` or the `active` check is
false and `buildFailure` falls through to the unchanged `outcome: null` path).

### Step 3 — prove the walk keeps advancing the cursor across more than one tail box in a resumed pass

The per-box cursor write (`runStepHook.ts:366-371`) and the `inFailureChain` derivation
(`runStepHook.ts:342`) are already live; nothing in this step changes production code. It has no
test proving the walk *keeps* advancing the cursor once resumed mid-tail, rather than only landing
on the first resumed box — add one.

Test name: `test_runStepHook_advancesTheTailCursorAcrossMultipleBoxesAfterAResumedBoxSucceeds`,
added to `tests/runStepHook.test.ts`. `MIDDLE`'s script crashes on its first invocation and succeeds
on the second (a marker file on disk distinguishes the two), standing in for any real failures-exit
box that fails once and is safe to retry (e.g. `RELEASE_SOURCE_LOCK`, whose own release call
reproves ownership and is a no-op if already released):
```ts
test("test_runStepHook_advancesTheTailCursorAcrossMultipleBoxesAfterAResumedBoxSucceeds", () => {
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

    // FAILURES_EXIT echoes packet fields forward (matching the real FAILURES_EXIT.ts's
    // `{...packet, box, scriptSignal}` spread — writeStep()'s canned result does not echo its own
    // input, so this step's result must name the fields itself). MIDDLE crashes once via a marker
    // file, then succeeds; LAST is an ordinary box after it.
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

    // Pass 1: A routes into the tail (via its own explicit next, the existing decision-box path);
    // FAILURES_EXIT runs; MIDDLE crashes on its first run.
    const first = runHook(`/run-step A ${startInput}`, configFile);
    assert.equal(first.result.ok, false);

    // Pass 2: a fresh invocation at the preamble resumes at MIDDLE, which now succeeds, and the
    // walk keeps going through LAST and STOP in the same pass.
    const second = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile);
    assert.equal(second.result.ok, true);
    assert.deepEqual(second.result.ran, [
        "pipeline-failuresExit.mmd::MIDDLE", "pipeline-failuresExit.mmd::LAST", "pipeline-failuresExit.mmd::STOP",
    ]);
});
```
This already passes against the live code (the mechanism it exercises is already shipped) — it is
still worth adding as a permanent regression guard: without the `inFailureChain` derivation and the
per-box cursor write, resume would land on `MIDDLE` (row 2's frozen checkpoint still points at `A`,
so this specific assertion would actually catch that regression via `second.result.ran` not
starting with `MIDDLE` at all) but a subsequent failure in `LAST` would silently fall back to
retrying `MIDDLE`'s stale checkpoint instead of `LAST`'s own — this test's `deepEqual` on the full
three-box `ran` array is what would catch that narrower regression.

### Step 4 — `REPORT_EXIT_TYPE_AND_NOTE` clears the cursor

Test-first, rewriting `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.test.ts` so its
existing test uses a real, seeded `projectRoot` instead of the fictitious `"/repo"`, then adding a
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

This fails (RED): `main()` does not call `writeTailCursor` yet, so the second test's `tailCursor`
stays set instead of `null`, and the first test throws `"task 169 not found"` before this rewrite.

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

### Step 5 — table-driven test: inject one failure at each real `pipeline-failuresExit.mmd` box

Added to `tests/runStepHook.test.ts`. This is the coverage Step 3 cannot give by itself: Step 3
proves the mechanism with one synthetic box; this proves it for every real box script, using each
box's own real `<BOX>.template.json` input as a realistic starting packet, and a wrapper script that
crashes exactly once before delegating to the real production script — so the real script genuinely
runs and its real output feeds the real next box, exactly as `tests/stepTemplates.test.ts` already
proves happens edge-by-edge.

Runs against an **isolated copy** of `scripts/tackle-tasks/failuresExit/fixtures`, not the shared
in-place one: `tests/stepTemplates.test.ts` resets and reads that exact fixture on every `npm test`
run, and `node --test` can run test files concurrently, so sharing it here would be flaky by
construction.

```ts
import { cpSync } from "node:fs"; // add to the existing node:fs import list at the top of the file

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_SOURCE_DIR = join(PROJECT_ROOT, "scripts/tackle-tasks/failuresExit/fixtures");
const REAL_STEPS_JSON = JSON.parse(readFileSync(join(PROJECT_ROOT, "scripts/steps.json"), "utf8")) as
    Record<string, { box: string; script: string; template: string; next: string[] }[]>;

// A one-shot fixture: setup.sh only ever needs itself and `git` on PATH, so copying just the script
// into a fresh temp directory and running it there gives each table row its own isolated repo.
function makeIsolatedFailuresExitFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "failuresExit-fixture-"));
    cpSync(join(FIXTURE_SOURCE_DIR, "setup.sh"), join(dir, "setup.sh"));
    const setupResult = spawnSync("bash", ["setup.sh"], { cwd: dir, encoding: "utf8" });
    if (setupResult.status !== 0) throw new Error(`isolated fixture setup failed:\n${setupResult.stdout}${setupResult.stderr}`);
    return dir;
}

// Crashes once (a marker file survives between the two invocations), then delegates to the real
// production script with the exact same argv — proving the real script itself completes correctly
// once retried, not just that some script at this path was chosen.
function makeCrashOnceThenDelegateScript(folder: string, realScriptPath: string): string {
    const marker = join(folder, "ran-once");
    const wrapperPath = join(folder, "wrapper.ts");
    writeFileSync(wrapperPath, [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import { execFileSync } from "node:child_process";',
        `const marker = ${JSON.stringify(marker)};`,
        'if (!existsSync(marker)) { writeFileSync(marker, "1"); process.exit(1); }',
        `process.stdout.write(execFileSync("node", ["--no-inspect", ${JSON.stringify(realScriptPath)}, process.argv[2] ?? ""], { encoding: "utf8" }));`,
    ].join("\n"));
    return wrapperPath;
}

for (const entry of REAL_STEPS_JSON["pipeline-failuresExit.mmd"] ?? []) {
    if (entry.box === "STOP") continue; // no script, nothing to inject a failure into
    test(`test_runStepHook_injectsOneFailureAt_${entry.box}_andResumeContinuesTheChain`, () => {
        const isolatedFixtureDir = makeIsolatedFailuresExitFixture();
        const templateRaw = readFileSync(join(PROJECT_ROOT, entry.template), "utf8")
            .replaceAll("{{PROJECT_ROOT}}/scripts/tackle-tasks/failuresExit/fixtures", isolatedFixtureDir);
        const templateInput = (JSON.parse(templateRaw) as { input: Record<string, unknown> }).input;
        const taskNumber = Number(templateInput.taskNumber);
        const projectRoot = String(templateInput.projectRoot);
        const stepKey = `pipeline-failuresExit.mmd::${entry.box}`;

        const wrapperFolder = mkdtempSync(join(tmpdir(), `run-step-inject-${entry.box}-`));
        const wrapperScript = makeCrashOnceThenDelegateScript(wrapperFolder, join(PROJECT_ROOT, entry.script));
        const overriddenConfig = JSON.parse(JSON.stringify(REAL_STEPS_JSON));
        overriddenConfig["pipeline-failuresExit.mmd"].find((candidate: { box: string }) => candidate.box === entry.box)!.script = wrapperScript;
        const configFile = join(wrapperFolder, "steps.json");
        writeFileSync(configFile, JSON.stringify(overriddenConfig));
        const startInput = JSON.stringify(templateInput);

        // Test action, pass 1: the box crashes on its first, real invocation.
        const first = runHook(`/run-step ${stepKey} ${startInput}`, configFile);
        assert.equal(first.result.ok, false, JSON.stringify(first.result));

        // Verification: a durable tail cursor now names this exact box and input.
        assert.deepEqual(
            readTaskRunState(taskNumber, projectRoot).history[0].tailCursor,
            { block: stepKey, input: startInput },
        );

        // Test action, pass 2: the next invocation — literally what resumeRun.ts's row 0 hands
        // back for this cursor — retries the same box, which now delegates to the real script and
        // succeeds, and the walk runs the rest of the real chain to completion.
        const second = runHook(`/run-step ${stepKey} ${startInput}`, configFile);
        assert.equal(second.result.ok, true, JSON.stringify(second.result));
        assert.equal(second.result.ran[0], stepKey);
    });
}
```
Add `readTaskRunState` (already added in Step 2) and `cpSync` to this file's imports.

Like Step 3, this already passes against the live code, and is independent of Steps 1, 2, and 4:
each row starts the walk directly at `pipeline-failuresExit.mmd::<BOX>`, so the already-shipped
`inFailureChain` derivation and per-box cursor write (Step 3's mechanism, not this step's) are what
make it pass — no box here ever carries `exitType: "block-failed"` or reaches
`REPORT_EXIT_TYPE_AND_NOTE`'s new clear. Add it anyway, as the permanent regression guard Step 3
cannot provide by itself: Step 3 proves the mechanism on one synthetic box; this proves it on every
real one, using each box's own real script and real template.

Run `npm test -- tests/runStepHook.test.ts`: one passing test per real failures-exit box (12 boxes,
excluding `STOP`).

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

## Note for the implementer

Re-read every file this plan cites before editing it — another session has been actively landing
related work (task 16's `tailCursor`/`writeTailCursor`/row 0, and this plan's own `inFailureChain`
derivation and per-box cursor write, are already live, per the "Current state" section above; do
not re-implement them, and do not assume any other file this plan cites is still in the state
described here without re-checking it first).
