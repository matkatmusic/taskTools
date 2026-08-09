// Covers the two pieces of step-6 logic that used to be prose in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { beginNextLap, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordStageOutcome } from "../scripts/runMergePhase.ts";

test("test_hasLapRemainingAllowsExactlyTwoLapsThenStops", () => {
    assert.equal(MAX_LAPS, 2);
    assert.equal(hasLapRemaining(0), true);
    assert.equal(hasLapRemaining(1), true);
    assert.equal(hasLapRemaining(2), false);
});

test("test_judgeMergeRunReportsMergedWhenTheScriptExitsCleanWithNoConflicts", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [{ branch: "new-usage-graph" }] });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "merged");
    assert.equal(verdict.failure, null);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsNonZero", () => {
    const verdict = judgeMergeRun({ exitCode: 1, stdout: "", stderr: "boom" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.equal(verdict.failure?.error, "1: boom");
    assert.deepEqual(verdict.failure?.conflicts, []);
    assert.equal(verdict.failure?.failedCommand, "cmd");
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButReportsConflicts", () => {
    const conflicts = [{ groupId: 1, merged: false }];
    const verdict = judgeMergeRun({ exitCode: 0, stdout: JSON.stringify({ merged: [], conflicts }), stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.deepEqual(verdict.failure?.conflicts, conflicts);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptPrintsSomethingOtherThanJson", () => {
    const verdict = judgeMergeRun({ exitCode: 0, stdout: "Debugger attached.", stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /not JSON/);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButPublishedNothing", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [], runState: { status: "approved" } });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /published nothing/);
});

test("test_recordStageOutcomeRequeuesAFailedTaskToTheBackAndRetriesItNextLapWhileAnotherTaskMerges", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 10);
    queue = enqueueApprovedTask(queue, 20);

    assert.deepEqual(nextQueueStep(queue), { taskNumber: 10, stage: "rebase-test" });
    queue = recordStageOutcome(queue, 10, "rebase-test", { status: "success" });
    assert.deepEqual(nextQueueStep(queue), { taskNumber: 10, stage: "merge" });
    queue = recordStageOutcome(queue, 10, "merge", { status: "success" });
    assert.deepEqual(queue.merged, [10]);

    assert.deepEqual(nextQueueStep(queue), { taskNumber: 20, stage: "rebase-test" });
    queue = recordStageOutcome(queue, 20, "rebase-test", { status: "failure", reason: "rebase conflicted: a.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.deepEqual(queue.merged, [10]);
    assert.deepEqual(queue.unmerged, []);
    assert.deepEqual(queue.carryover, [{ taskNumber: 20, stage: "rebase-test", lapsAttempted: 1, lastFailure: "rebase conflicted: a.ts" }]);

    queue = beginNextLap(queue);
    assert.deepEqual(nextQueueStep(queue), { taskNumber: 20, stage: "rebase-test" });
});

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
