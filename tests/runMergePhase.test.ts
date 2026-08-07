// Covers the two pieces of step-6 logic that used to be prose in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergeOutcomes, judgeMergeRun } from "../scripts/runMergePhase.ts";

test("test_buildMergeOutcomesDerivesCountsFromTheStepArrays", () => {
    const outcomes = buildMergeOutcomes({
        done: [1, 2, 3],
        partial: [4],
        blocked: [],
        needsClarification: [5, 6],
        requeueCount: 2,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    });

    assert.deepEqual(outcomes, {
        doneCount: 3,
        partialCount: 1,
        blockedCount: 0,
        needsClarificationCount: 2,
        requeueCount: 2,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    });
});

test("test_buildMergeOutcomesTreatsEveryMissingStepAsZero", () => {
    assert.deepEqual(buildMergeOutcomes({}), {
        doneCount: 0,
        partialCount: 0,
        blockedCount: 0,
        needsClarificationCount: 0,
        requeueCount: 0,
        testReceipts: [],
        reviewHandoffs: [],
    });
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
