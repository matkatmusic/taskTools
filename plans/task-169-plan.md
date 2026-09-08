# Task 169 plan: distinct "done" terminal state for the merge queue (audit C86-04)

## Problem

`shouldEndQueue` in `scripts/runMergePhase.ts` returns `boolean`, and its only "queue is
finished" signal (`true`) is the zero-merge ceiling: `currentLapIsComplete(queue) &&
queue.mergedThisLap === 0 && !workflowOutstanding`. After the final successful merge the
normal state is `pending=[]`, `carryover=[]`, `mergedThisLap=1`, no outstanding workflow —
`mergedThisLap !== 0`, so this returns `false`. The generated driver in
`scripts/tackleTasksBrief.ts` treats `false` (with empty carryover) as "a task is still
planning/implementing/waiting on its gate — wait for the next enqueue or completion
notification". No further notification ever arrives, so the queue stalls forever.

## Fix

Change `shouldEndQueue`'s return type from `boolean` to a 3-value union
`"continue" | "done" | "stuck"`:

- `"stuck"` — a lap merged zero tasks (`mergedThisLap === 0`) AND that lap has failures on
  record (`carryover.length > 0 || unmerged.length > 0`). This is the old `true`/ceiling case.
- `"done"` — new terminal state: `carryover` is empty (nothing left to retry), **regardless
  of `mergedThisLap`** — this covers both the final-successful-merge case
  (`mergedThisLap === 1+`, `carryover === []`) and a lap that completed with nothing merged
  and no failures at all (`mergedThisLap === 0`, `carryover === []`, `unmerged === []`), per
  the brief's explicit "regardless of mergedThisLap" requirement.
- `"continue"` — everything else: a workflow is still outstanding, the lap isn't complete
  yet, or the lap merged something but also left retryable carryover (retry via
  `beginNextLap`).

`"stuck"` is checked before `"done"` so a zero-merge lap with recorded failures is never
misreported as `"done"` merely because `carryover` happens to be empty (e.g. all failures
already rolled over to `unmerged` at the 2-lap ceiling).

This makes "done" (success) reported as a different string from "stuck" (the zero-merge
ceiling), so the driver can tell them apart, per the brief's requirement.

## File-by-file edits

### scripts/runMergePhase.ts

Current lines 90-93 (verified by direct read):

```
// Ends the queue after a zero-merge lap, unless a task workflow is still outstanding (task 148).
export function shouldEndQueue(queue: MergeQueue, workflowOutstanding: boolean): boolean {
    return currentLapIsComplete(queue) && queue.mergedThisLap === 0 && !workflowOutstanding;
}
```

Replace with:

```
// "done": nothing left to retry, regardless of mergedThisLap. "stuck": zero-merge lap with recorded failures. Else "continue" (task 169).
export type QueueEndState = "continue" | "done" | "stuck";

export function shouldEndQueue(queue: MergeQueue, workflowOutstanding: boolean): QueueEndState {
    if (workflowOutstanding || !currentLapIsComplete(queue)) return "continue";
    if (queue.mergedThisLap === 0 && (queue.carryover.length > 0 || queue.unmerged.length > 0)) return "stuck";
    return queue.carryover.length === 0 ? "done" : "continue";
}
```

No other line in this file references `shouldEndQueue` or its return type — `TerminalReason`,
`UnmergedTaskReport`, `MergeReport`, and `buildMergeReport` all key off `queue.unmerged` /
`queue.carryover` directly and are untouched by this change.

### scripts/tackleTasksBrief.ts

Current line 148 (verified by direct read), step 3 of the "## Merge queue" numbered list:

```
3. Run \`shouldEndQueue(queue, workflowOutstanding)\`. If it prints \`true\`, the queue is done: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user. If it prints \`false\` and \`queue\`'s \`carryover\` is non-empty, run \`beginNextLap(queue)\`, record the printed JSON as the new \`queue\`, and go back to step 1. If it prints \`false\` and \`carryover\` is empty, a task is still planning, implementing, or waiting on its own gate — wait for the next enqueue or completion notification, then go back to step 1.
```

Replace with:

```
3. Run \`shouldEndQueue(queue, workflowOutstanding)\`. If it prints \`"done"\`, no pending or retryable work remains: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user. If it prints \`"stuck"\`, a lap merged zero tasks and nothing is outstanding: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user the same way. If it prints \`"continue"\` and \`queue\`'s \`carryover\` is non-empty, run \`beginNextLap(queue)\`, record the printed JSON as the new \`queue\`, and go back to step 1. If it prints \`"continue"\` and \`carryover\` is empty, a task is still planning, implementing, or waiting on its own gate — wait for the next enqueue or completion notification, then go back to step 1.
```

This is the only line in the file that mentions `shouldEndQueue`'s return value. The line
above it ("- End check: `FN` = `shouldEndQueue`, `ARGS` = `<QUEUE_JSON>, workflowOutstanding`.")
and every other reference to `shouldEndQueue(queue, workflowOutstanding)` in the file (the
table row and the literal call inside the step-3 sentence itself) are left untouched — the
call shape doesn't change, only what the three possible printed values mean.

### tests/runMergePhase.test.ts

Five assertions compare `shouldEndQueue`'s return value against a boolean; all five must
become their corresponding string literal, and one test's body/name describes the pre-fix
(defective) behavior and must be corrected to describe the fix. Three new tests are added: one
for the "continue despite a merge, because carryover is non-empty" branch, one for the "done
despite mergedThisLap === 0, because nothing failed either" branch, and one for the "stuck
despite carryover being empty, because unmerged holds a prior lap's failure" branch — the three
branch combinations inside the new function with no existing coverage.

**Edit 1** — line 101, inside `test_shouldEndQueueEndsTheQueueWhenALapMergesZeroTasksAndNoWorkflowIsOutstanding` (lines 95-102). This case is genuinely the zero-merge ceiling (`mergedThisLap` stays `0`), so it still ends the queue, just now reported as `"stuck"` instead of `true`. Current line 101:

```
    assert.equal(shouldEndQueue(queue, false), true);
```

Replace with:

```
    assert.equal(shouldEndQueue(queue, false), "stuck");
```

**Edit 2** — line 110, inside `test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding` (lines 104-111). A workflow is outstanding, so this is `"continue"` instead of `false`. Current line 110:

```
    assert.equal(shouldEndQueue(queue, true), false);
```

Replace with:

```
    assert.equal(shouldEndQueue(queue, true), "continue");
```

**Edit 3** — the test at lines 113-121. This is the defect the task exists to fix: task 60
fully merges (`mergedThisLap` becomes `1`, `carryover` stays empty), which is exactly the
"final successful merge" shape from the brief, and it must now report `"done"`, not `false`.
Current lines 113-121:

```
test("test_shouldEndQueueDoesNotEndTheQueueWhenALapMergedAtLeastOneTask", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 60);
    queue = recordStageOutcome(queue, 60, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 60, "merge", { status: "success" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), false);
});
```

Replace with:

```
test("test_shouldEndQueueReportsDoneWhenALapMergedEveryTaskAndLeftNoCarryover", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 60);
    queue = recordStageOutcome(queue, 60, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 60, "merge", { status: "success" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "done");
});

test("test_shouldEndQueueContinuesWhenALapMergedAtLeastOneTaskButLeftCarryoverToRetry", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 61);
    queue = enqueueApprovedTask(queue, 62);
    queue = recordStageOutcome(queue, 61, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 61, "merge", { status: "success" });
    queue = recordStageOutcome(queue, 62, "rebase-test", { status: "failure", reason: "rebase conflicted: h.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "continue");
});
```

(Traced: task 61 enqueues, succeeds rebase-test then merge — `merged=[61]`, `mergedThisLap=1`,
`pending=[]`. Task 62 enqueues, fails rebase-test with a lap remaining
(`hasLapRemaining(1)` is `true` since `MAX_LAPS` is 2) — its failure record moves to
`carryover`, `pending=[]`. So the lap is complete, `mergedThisLap` is `1` (not `0`), and
`carryover` has one entry, which is exactly the new `"continue"` branch —
`queue.carryover.length === 0 ? "done" : "continue"` — that no other test exercises.)

**Edit 4** — line 156, inside `test_buildMergeReportNamesTheQueueExitNotTheCeilingWhenATaskWasStillRetryable` (lines 151-162). Task 90's lap merges zero tasks, so this is still `"stuck"`, not `true`. Current line 156:

```
    assert.equal(shouldEndQueue(queue, false), true);
```

Replace with:

```
    assert.equal(shouldEndQueue(queue, false), "stuck");
```

**Edit 5** — lines 273-274, inside `test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged` (lines 246-283). This is the brief's cited `:277-281` case (line numbers shifted slightly from the brief's embedded copy to the live file, but it is the same assertion): the task merges cleanly, `carryover` stays empty, so this becomes `"done"`, not `false`. Current lines 273-274:

```
        // shouldEndQueue only fires on a zero-merge lap; a merged lap waits for the next enqueue.
        assert.equal(shouldEndQueue(queue, false), false);
```

Replace with:

```
        // All work landed and nothing is outstanding: the terminal state is "done", not "stuck".
        assert.equal(shouldEndQueue(queue, false), "done");
```

**Edit 6** — new test covering the "done" branch that has no existing coverage: `mergedThisLap`
stays `0` (nothing to merge), but there are also no failures at all, so it's `"done"`, not
`"stuck"`. Add after Edit 5's block (end of file, before the closing of the test suite):

```
test("test_shouldEndQueueReportsDoneOnAnUntouchedQueueWithNothingToDoAndNoFailures", () => {
    const queue = createMergeQueue();

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "done");
});
```

(Traced: `createMergeQueue()` returns `pending: [], carryover: [], mergedThisLap: 0, unmerged:
[]`. `currentLapIsComplete` is true on an empty `pending`. `mergedThisLap === 0` but
`carryover.length === 0 && unmerged.length === 0`, so the `"stuck"` guard's second condition
is false — falls through to `carryover.length === 0 ? "done" : "continue"`, which is `"done"`.
This is the brief's "regardless of mergedThisLap" case: a completed lap with nothing merged
and nothing failed is still `"done"`, not `"stuck"`.)

**Edit 7** — new test covering the case where `mergedThisLap === 0` but `unmerged` (not
`carryover`) holds the failure, i.e. the lap already exhausted its retries in a *previous* lap
and this lap simply had nothing new to do. Add directly after Edit 6's test:

```
test("test_shouldEndQueueReportsStuckWhenALapMergesNothingAndAPriorLapsFailureIsInUnmerged", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 91);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts again" });

    assert.deepEqual(queue.unmerged, [{ taskNumber: 91, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: i.ts again" }]);
    assert.deepEqual(queue.carryover, []);
    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "stuck");
});
```

(Traced: task 91 fails lap 0 with a lap remaining (`hasLapRemaining(1)` is `true`) — moves to
`carryover`. `beginNextLap` rotates `carryover` into `pending` and resets `mergedThisLap` to
`0`. Task 91 fails again at lap 1 — `hasLapRemaining(2)` is `false` — moves to `unmerged`
instead of `carryover`. Final state: `mergedThisLap === 0`, `carryover === []`, `unmerged`
has one entry. Without checking `unmerged` in the `"stuck"` guard, this would wrongly report
`"done"` merely because `carryover` is empty — this is exactly the case the FIXES from the
first review round were guarding against.)

### tests/tackleTasksBrief.test.ts

No edit needed to any assertion. This file's assertions about the "## Merge queue" section
(lines 68-85) check for the literal substrings `createMergeQueue`, `enqueueApprovedTask(queue,
taskNumber)`, `nextQueueStep(queue)`, the background-launch args shape,
`recordStageOutcome(queue, taskNumber, stage, outcome)`, `shouldEndQueue(queue,
workflowOutstanding)`, `buildMergeReport(queue)`, `outstandingEntries`, "immediately ask that
task's own approval gate", and "do not launch anything...wait for that workflow's completion
notification" (verified by direct read of `tests/tackleTasksBrief.test.ts` lines 68-85) — every
one of these is a substring match (`assert.match`/`assert.doesNotMatch` with a regex), not a
byte-for-byte comparison of the full step-3 sentence, and none of the matched substrings falls
inside the `true`/`false`/`"done"`/`"stuck"`/`"continue"` wording being changed in step 3's
prose. The literal call `shouldEndQueue(queue, workflowOutstanding)` that one of them matches
is preserved verbatim in the new step 3 text (see the `scripts/tackleTasksBrief.ts` section
above). This file was added to task 169's owned files only because it imports and checks
`tackleTasksBrief`'s output for the driver shape, so it must be re-checked against the new
step 3 wording — which this section does, line by line above — not because any line in the
test file itself needs editing.

## Verification

Run, from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
npx tsc --noEmit
```

Expected: no errors (in particular, no type error from `assert.equal`'s use of the new
`QueueEndState` union, and no leftover call site still expecting a `boolean` from
`shouldEndQueue`).

```
npm test
```

Expected: all tests pass, including every test in `tests/runMergePhase.test.ts` (the five
edited assertions plus the three new tests —
`test_shouldEndQueueContinuesWhenALapMergedAtLeastOneTaskButLeftCarryoverToRetry`,
`test_shouldEndQueueReportsDoneOnAnUntouchedQueueWithNothingToDoAndNoFailures`, and
`test_shouldEndQueueReportsStuckWhenALapMergesNothingAndAPriorLapsFailureIsInUnmerged`)
and every test in `tests/tackleTasksBrief.test.ts` (unchanged, still green because its
substring matches don't touch the edited step-3 sentence's changed wording).
