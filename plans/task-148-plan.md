# Task 148 Plan: end the merge queue on a lap that merged zero tasks

## Summary

Add a zero-merge early-exit check on top of task 146's 2-lap ceiling (`MAX_LAPS`, unchanged). When a lap
finishes having merged zero tasks, and no task workflow is still outstanding, the queue should end instead
of starting another lap. If a task workflow is still outstanding (still running, or finished but not yet
approved), a zero-merge lap must NOT end the queue.

The "task workflow still outstanding" fact is owned by the orchestrator (task 147's boundary) and is
consumed here as a plain boolean parameter — this file does not discover it.

To know whether a just-finished lap merged zero tasks, `MergeQueue` needs a per-lap merge counter
(`mergedThisLap`) that resets when a new lap begins and increments each time a task merges. `queue.merged`
is a cumulative, whole-run list and cannot by itself answer "did *this* lap merge anything".

## Owned files

### `scripts/runMergePhase.ts` — 5 edits

**Edit 1 — add `mergedThisLap` to the `MergeQueue` type (lines 50-55)**

Current:
```
export type MergeQueue = {
    pending: QueueTask[];
    carryover: QueueTask[];
    merged: number[];
    unmerged: QueueTask[];
};
```

Becomes:
```
export type MergeQueue = {
    pending: QueueTask[];
    carryover: QueueTask[];
    merged: number[];
    mergedThisLap: number;
    unmerged: QueueTask[];
};
```

**Edit 2 — initialize `mergedThisLap` in `createMergeQueue` (lines 61-63)**

Current:
```
export function createMergeQueue(): MergeQueue {
    return { pending: [], carryover: [], merged: [], unmerged: [] };
}
```

Becomes:
```
export function createMergeQueue(): MergeQueue {
    return { pending: [], carryover: [], merged: [], mergedThisLap: 0, unmerged: [] };
}
```

**Edit 3 — insert `shouldEndQueue` right after `currentLapIsComplete` (after line 79, before line 81)**

Current (lines 77-84, for anchoring — lines 77-79 are the insertion anchor, lines 81-84 stay unchanged and follow immediately after the insertion):
```
export function currentLapIsComplete(queue: MergeQueue): boolean {
    return queue.pending.length === 0;
}

// Rotates a finished lap's carryover (failures with a lap remaining) into the next lap's pending list.
export function beginNextLap(queue: MergeQueue): MergeQueue {
    return { ...queue, pending: queue.carryover, carryover: [] };
}
```

Becomes:
```
export function currentLapIsComplete(queue: MergeQueue): boolean {
    return queue.pending.length === 0;
}

// Ends the queue after a zero-merge lap, unless a task workflow is still outstanding (task 148).
export function shouldEndQueue(queue: MergeQueue, workflowOutstanding: boolean): boolean {
    return currentLapIsComplete(queue) && queue.mergedThisLap === 0 && !workflowOutstanding;
}

// Rotates a finished lap's carryover (failures with a lap remaining) into the next lap's pending list.
export function beginNextLap(queue: MergeQueue): MergeQueue {
    return { ...queue, pending: queue.carryover, carryover: [], mergedThisLap: 0 };
}
```

(This one replacement covers both Edit 3 — the new `shouldEndQueue` function — and Edit 4 below, since
they sit in the same contiguous block.)

**Edit 4 — reset `mergedThisLap` in `beginNextLap`**

Included in the Edit 3 replacement above: `beginNextLap`'s body changes from
`return { ...queue, pending: queue.carryover, carryover: [] };` to
`return { ...queue, pending: queue.carryover, carryover: [], mergedThisLap: 0 };`.

**Edit 5 — increment `mergedThisLap` on a successful merge in `recordStageOutcome` (line 94)**

Current (lines 86-101, edit is on line 94):
```
export function recordStageOutcome(queue: MergeQueue, taskNumber: number, stage: QueueStage, outcome: StageOutcome): MergeQueue {
    const head = queue.pending[0];
    if (!head || head.taskNumber !== taskNumber || head.stage !== stage) {
        throw new Error(`recordStageOutcome expected the queue's head to be task ${taskNumber} at stage "${stage}"`);
    }
    const rest = queue.pending.slice(1);
    if (outcome.status === "success") {
        if (stage === "rebase-test") return { ...queue, pending: [{ ...head, stage: "merge" }, ...rest] };
        return { ...queue, pending: rest, merged: [...queue.merged, taskNumber] };
    }
    const lapsAttempted = head.lapsAttempted + 1;
    const failed: QueueTask = { taskNumber, stage: "rebase-test", lapsAttempted, lastFailure: outcome.reason };
    return hasLapRemaining(lapsAttempted)
        ? { ...queue, pending: rest, carryover: [...queue.carryover, failed] }
        : { ...queue, pending: rest, unmerged: [...queue.unmerged, failed] };
}
```

Only line 94 changes, from:
```
        return { ...queue, pending: rest, merged: [...queue.merged, taskNumber] };
```
to:
```
        return { ...queue, pending: rest, merged: [...queue.merged, taskNumber], mergedThisLap: queue.mergedThisLap + 1 };
```

**No other edits to this file.** Every other exported function (`enqueueApprovedTask`, `nextQueueStep`,
`judgeMergeRun`, `archiveIfMerged`, `isArchiveRequest`, `isFullyPublishable`, `archiveRequestIsComplete`,
`blockedVerdict`) either builds its `MergeQueue` via `{ ...queue, ... }` spread (which carries
`mergedThisLap` through untouched) or never touches `MergeQueue` at all. `MAX_LAPS` and
`hasLapRemaining` are the 2-lap ceiling this task builds on top of and are not modified. The retired
(commented-out) code block at the bottom of the file is untouched.

### `tests/runMergePhase.test.ts` — 2 edits

**Edit 1 — add `shouldEndQueue` to the import list (line 4)**

Current:
```
import { beginNextLap, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordStageOutcome } from "../scripts/runMergePhase.ts";
```

Becomes:
```
import { beginNextLap, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordStageOutcome, shouldEndQueue } from "../scripts/runMergePhase.ts";
```

**Edit 2 — append 3 new tests after the last existing test (after line 86 `});`, before the trailing blank
line 87)**

Current end of file (lines 76-87):
```
test("test_recordStageOutcomeLeavesATaskUnmergedAfterItsSecondLapFails", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 30);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts again" });

    assert.deepEqual(queue.merged, []);
    assert.deepEqual(queue.carryover, []);
    assert.deepEqual(queue.unmerged, [{ taskNumber: 30, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: b.ts again" }]);
});
```
(followed by a trailing blank line, line 87)

Becomes (same block, with 3 new tests appended after it, still followed by a trailing blank line):
```
test("test_recordStageOutcomeLeavesATaskUnmergedAfterItsSecondLapFails", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 30);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts again" });

    assert.deepEqual(queue.merged, []);
    assert.deepEqual(queue.carryover, []);
    assert.deepEqual(queue.unmerged, [{ taskNumber: 30, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: b.ts again" }]);
});

test("test_shouldEndQueueEndsTheQueueWhenALapMergesZeroTasksAndNoWorkflowIsOutstanding", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 40);
    queue = recordStageOutcome(queue, 40, "rebase-test", { status: "failure", reason: "rebase conflicted: c.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), true);
});

test("test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 50);
    queue = recordStageOutcome(queue, 50, "rebase-test", { status: "failure", reason: "rebase conflicted: d.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, true), false);
});

test("test_shouldEndQueueDoesNotEndTheQueueWhenALapMergedAtLeastOneTask", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 60);
    queue = recordStageOutcome(queue, 60, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 60, "merge", { status: "success" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), false);
});
```

## Why this satisfies the brief

- The 2-lap ceiling (`MAX_LAPS`, `hasLapRemaining`) is untouched — not removed, raised, or globalised.
- `shouldEndQueue` only fires once a lap is actually complete (`currentLapIsComplete`) and that lap's own
  merge count (`mergedThisLap`, reset each `beginNextLap`) is zero — not the whole run's cumulative count.
- The outstanding-workflow fact is a parameter (`workflowOutstanding: boolean`) the caller supplies; this
  file consumes it, it does not compute or discover it, matching the task 147 boundary.
- `test_shouldEndQueueEndsTheQueueWhenALapMergesZeroTasksAndNoWorkflowIsOutstanding` covers the brief's
  first TEST line (zero-merge lap, nothing outstanding → ends the queue).
- `test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding` covers the
  brief's second TEST line (zero-merge lap, something outstanding → does not end the queue).
- `test_shouldEndQueueDoesNotEndTheQueueWhenALapMergedAtLeastOneTask` covers the split description's
  "a lap that merges at least one task starts another lap" case.

## Verification

Run the test suite and confirm all tests pass, including the 3 new ones:

```
npm test
```

Expected: exit code 0, no failing tests. The output includes (among the existing passing tests):
- `test_shouldEndQueueEndsTheQueueWhenALapMergesZeroTasksAndNoWorkflowIsOutstanding` — pass
- `test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding` — pass
- `test_shouldEndQueueDoesNotEndTheQueueWhenALapMergedAtLeastOneTask` — pass

As a targeted check, this also works and should print `pass 12` (the file's existing 9 tests plus the 3
new ones), `fail 0`:

```
node --test tests/runMergePhase.test.ts
```
