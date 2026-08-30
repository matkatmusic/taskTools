# Task 149 plan: report every unmerged task, with `lastFailure` and `terminalReason`

## Goal

Add a report-building layer on top of the serial `MergeQueue` (built by tasks 146-148) that,
when the queue ends, names every task that did not merge with two separate fields:

- `lastFailure` — the concrete failure of the task's last attempt (already carried on
  `QueueTask.lastFailure` by `recordStageOutcome`; nothing new to compute here).
- `terminalReason` — why no further attempt ran: `"2-lap ceiling reached"` for tasks in
  `queue.unmerged`, or `"zero-merge lap ended the queue"` for tasks still sitting in
  `queue.carryover` when the queue is ended by `shouldEndQueue` (i.e. task 148's zero-merge
  lap ended the queue before `beginNextLap` gave them another lap).

It also adds the "merged but not closed" outcome (task 152's case): a task whose merge
succeeded but whose close (archival) did not. That is tracked apart from `unmerged` — the
merge is not unwound, so it is neither merged-and-done nor unmerged.

No stage machinery for cleanup/merge/close (tasks 150-152) is added here — those stages don't
exist in this file yet and are out of scope for task 149. This task only builds the reporting
shape and the recording function (`recordMergedNotClosed`) that task 152 will call once it
exists; `lastFailure` is already a free-form string, so it needs no change to carry cleanup
(150), merge (151), or close (152) failure text.

## Edits to `scripts/runMergePhase.ts`

### Edit 1 — add `MergedNotClosedTask` and extend `MergeQueue`

Current text (lines 43-56):

```
export type QueueTask = {
    taskNumber: number;
    stage: QueueStage;
    lapsAttempted: number;
    lastFailure: string | null;
};

export type MergeQueue = {
    pending: QueueTask[];
    carryover: QueueTask[];
    merged: number[];
    mergedThisLap: number;
    unmerged: QueueTask[];
};
```

Replace with:

```
export type QueueTask = {
    taskNumber: number;
    stage: QueueStage;
    lapsAttempted: number;
    lastFailure: string | null;
};

// Task 152 reports through here: the merge itself is not unwound, so this is tracked apart from `merged`.
export type MergedNotClosedTask = {
    taskNumber: number;
    commitHash: string;
    lastFailure: string;
};

export type MergeQueue = {
    pending: QueueTask[];
    carryover: QueueTask[];
    merged: number[];
    mergedThisLap: number;
    unmerged: QueueTask[];
    mergedNotClosed: MergedNotClosedTask[];
};
```

### Edit 2 — initialize `mergedNotClosed` in `createMergeQueue`

Current text (lines 62-64):

```
export function createMergeQueue(): MergeQueue {
    return { pending: [], carryover: [], merged: [], mergedThisLap: 0, unmerged: [] };
}
```

Replace with:

```
export function createMergeQueue(): MergeQueue {
    return { pending: [], carryover: [], merged: [], mergedThisLap: 0, unmerged: [], mergedNotClosed: [] };
}
```

### Edit 3 — add `recordMergedNotClosed`, the report types, and `buildMergeReport`

Current text (end of `recordStageOutcome`, lines 104-109):

```
    return hasLapRemaining(lapsAttempted)
        ? { ...queue, pending: rest, carryover: [...queue.carryover, failed] }
        : { ...queue, pending: rest, unmerged: [...queue.unmerged, failed] };
}

// RETIRED (task 147): derived run-outcomes.json's aggregate counts from one batch's StepOutputs arrays.
```

Replace with:

```
    return hasLapRemaining(lapsAttempted)
        ? { ...queue, pending: rest, carryover: [...queue.carryover, failed] }
        : { ...queue, pending: rest, unmerged: [...queue.unmerged, failed] };
}

// Task 152 calls this when merge succeeds but archival fails; the merge stays, reported separately from unmerged.
export function recordMergedNotClosed(queue: MergeQueue, taskNumber: number, commitHash: string, lastFailure: string): MergeQueue {
    return { ...queue, mergedNotClosed: [...queue.mergedNotClosed, { taskNumber, commitHash, lastFailure }] };
}

export type TerminalReason = "2-lap ceiling reached" | "zero-merge lap ended the queue";

export type UnmergedTaskReport = {
    taskNumber: number;
    lastFailure: string;
    terminalReason: TerminalReason;
};

export type MergeReport = {
    unmerged: UnmergedTaskReport[];
    mergedNotClosed: MergedNotClosedTask[];
};

// Reports queue.unmerged (hit the ceiling) and queue.carryover (retryable when the queue ended early); both left pending, unmerged.
export function buildMergeReport(queue: MergeQueue): MergeReport {
    const ceilingFailures: UnmergedTaskReport[] = queue.unmerged.map((task): UnmergedTaskReport => ({
        taskNumber: task.taskNumber,
        lastFailure: task.lastFailure as string,
        terminalReason: "2-lap ceiling reached",
    }));
    const queueExitFailures: UnmergedTaskReport[] = queue.carryover.map((task): UnmergedTaskReport => ({
        taskNumber: task.taskNumber,
        lastFailure: task.lastFailure as string,
        terminalReason: "zero-merge lap ended the queue",
    }));
    return { unmerged: [...ceilingFailures, ...queueExitFailures], mergedNotClosed: queue.mergedNotClosed };
}

// RETIRED (task 147): derived run-outcomes.json's aggregate counts from one batch's StepOutputs arrays.
```

`task.lastFailure` is typed `string | null` on `QueueTask`, but every task reaching
`queue.unmerged` or `queue.carryover` was placed there by `recordStageOutcome`'s failure
branch, which always sets `lastFailure: outcome.reason` (a string) — `enqueueApprovedTask` is
the only place `lastFailure` is ever `null`, and that task sits in `pending`, never in
`unmerged` or `carryover`. The `as string` assertion reflects that existing invariant; no
other change in this file affects it.

No other part of `scripts/runMergePhase.ts` needs an edit: `MergeFailure`, `MergePhaseVerdict`,
`judgeMergeRun`, `blockedVerdict`, `isArchiveRequest`, `isFullyPublishable`,
`archiveRequestIsComplete`, and `archiveIfMerged` are the old batch-verdict model, untouched by
this task's queue-report addition. The RETIRED comment blocks are left exactly as they are.

## Edits to `tests/runMergePhase.test.ts`

### Edit 1 — import the two new exports

Current text (line 4):

```
import { beginNextLap, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordStageOutcome, shouldEndQueue } from "../scripts/runMergePhase.ts";
```

Replace with:

```
import { beginNextLap, buildMergeReport, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordMergedNotClosed, recordStageOutcome, shouldEndQueue } from "../scripts/runMergePhase.ts";
```

### Edit 2 — append four new tests at end of file

Current text (lines 106-114, the last existing test, unchanged — anchor only):

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

Append immediately after it (still inside the file, nothing else follows):

```

test("test_buildMergeReportOmitsATaskThatFailedItsFirstLapButMergedItsSecondLap", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 70);
    queue = recordStageOutcome(queue, 70, "rebase-test", { status: "failure", reason: "rebase conflicted: e.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 70, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 70, "merge", { status: "success" });

    const report = buildMergeReport(queue);

    assert.deepEqual(queue.merged, [70]);
    assert.deepEqual(report.unmerged, []);
});

test("test_buildMergeReportCarriesBothFieldsForATaskThatHitTheTwoLapCeiling", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 80);
    queue = recordStageOutcome(queue, 80, "rebase-test", { status: "failure", reason: "unresolved merge conflict: f.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 80, "rebase-test", { status: "failure", reason: "unresolved merge conflict: f.ts again" });

    const report = buildMergeReport(queue);

    assert.deepEqual(report.unmerged, [
        { taskNumber: 80, lastFailure: "unresolved merge conflict: f.ts again", terminalReason: "2-lap ceiling reached" },
    ]);
});

test("test_buildMergeReportNamesTheQueueExitNotTheCeilingWhenATaskWasStillRetryable", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 90);
    queue = recordStageOutcome(queue, 90, "rebase-test", { status: "failure", reason: "rebase conflicted: g.ts" });

    assert.equal(shouldEndQueue(queue, false), true);
    const report = buildMergeReport(queue);

    assert.deepEqual(report.unmerged, [
        { taskNumber: 90, lastFailure: "rebase conflicted: g.ts", terminalReason: "zero-merge lap ended the queue" },
    ]);
});

test("test_buildMergeReportReportsMergedNotClosedAsItsOwnOutcomeWithTheCommitHash", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 100);
    queue = recordStageOutcome(queue, 100, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 100, "merge", { status: "success" });
    queue = recordMergedNotClosed(queue, 100, "abc123", "close failure: archival reported an incomplete result");

    const report = buildMergeReport(queue);

    assert.deepEqual(queue.merged, [100]);
    assert.deepEqual(report.unmerged, []);
    assert.deepEqual(report.mergedNotClosed, [
        { taskNumber: 100, commitHash: "abc123", lastFailure: "close failure: archival reported an incomplete result" },
    ]);
});
```

## Trace: why each new test proves the corresponding "done when" bullet

- `test_buildMergeReportOmitsATaskThatFailedItsFirstLapButMergedItsSecondLap` proves: "a task
  that FAILED its first lap and then MERGED on its second lap is reported as merged, and does
  not appear in the unmerged list or carry a failure reason" — task 70 fails lap 1 (goes to
  `carryover`), `beginNextLap` moves it to `pending`, it succeeds both stages on lap 2 and lands
  in `queue.merged`; `report.unmerged` is empty because `queue.unmerged` and `queue.carryover`
  are both empty at that point.
- `test_buildMergeReportCarriesBothFieldsForATaskThatHitTheTwoLapCeiling` proves: "an unmerged
  task carries BOTH fields" and "reports `lastFailure` = unresolved merge conflict AND
  `terminalReason` = 2-lap ceiling reached" — task 80 fails both laps
  (`lapsAttempted` reaches 2, `hasLapRemaining(2)` is false), so `recordStageOutcome` puts it in
  `queue.unmerged`; `buildMergeReport` reports it with the lap-2 failure text and
  `"2-lap ceiling reached"`.
- `test_buildMergeReportNamesTheQueueExitNotTheCeilingWhenATaskWasStillRetryable` proves: "a
  task still retryable when task 148's zero-merge lap ended the queue reports its own concrete
  `lastFailure` with `terminalReason` naming the queue exit, NOT the ceiling" — task 90 fails
  lap 1 only (`lapsAttempted` is 1, still has a lap remaining, so it sits in `carryover`, not
  `unmerged`); `shouldEndQueue(queue, false)` is `true` (the lap merged zero tasks and no
  workflow is outstanding), so the orchestrator would end the queue here instead of calling
  `beginNextLap`; `buildMergeReport` reads that same `carryover` entry and reports
  `"zero-merge lap ended the queue"`, never `"2-lap ceiling reached"`.
- `test_buildMergeReportReportsMergedNotClosedAsItsOwnOutcomeWithTheCommitHash` proves: "MERGED
  BUT NOT CLOSED (task 152) is reported as its own outcome, naming the merged commit hash" —
  task 100 merges cleanly (`queue.merged` contains it), then `recordMergedNotClosed` records a
  close failure with a commit hash; it is absent from `report.unmerged` (it did merge) and
  present in `report.mergedNotClosed` with the hash and the close-failure text.

Together with the four already-passing tests that exercise `recordStageOutcome`,
`shouldEndQueue`, and `beginNextLap` directly (unchanged by this task), this covers all four
`TEST:` bullets in the brief plus the merged-not-closed "done when" bullet.

## Verification

Run from the repo root:

```
npm test
```

Expected: the run ends with `ℹ fail 0` (currently `ℹ tests 1223` / `ℹ pass 1223` before this
task's four new tests are added; after adding them, `ℹ tests 1227` / `ℹ pass 1227`, still
`ℹ fail 0`), and the four new test names — `test_buildMergeReportOmitsATaskThatFailedItsFirstLapButMergedItsSecondLap`,
`test_buildMergeReportCarriesBothFieldsForATaskThatHitTheTwoLapCeiling`,
`test_buildMergeReportNamesTheQueueExitNotTheCeilingWhenATaskWasStillRetryable`, and
`test_buildMergeReportReportsMergedNotClosedAsItsOwnOutcomeWithTheCommitHash` — appear with a
`✔` in the output.
