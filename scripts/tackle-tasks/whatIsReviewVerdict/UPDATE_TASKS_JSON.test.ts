// Behavioral checks for UPDATE_TASKS_JSON.ts. Ported from pipeline-reviewPlan's UPDATE_TASK_ENTRY test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./UPDATE_TASKS_JSON.ts";
import { claimTask, getAttemptCount } from "../shared/taskRunState.ts";

function makeFixture(): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "update-tasks-json-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{ taskNumber: 42, title: "Fixture task", codexReviewNotes: "" }]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    claimTask(42, "run-1", projectRoot);
    return projectRoot;
}

function packet(projectRoot: string, notes: string) {
    return {
        box: "WHAT_IS_REVIEW_VERDICT", scriptSignal: "continue",
        taskNumber: 42, runId: "run-1", projectRoot, worktree: projectRoot, branch: "main",
        planFile: join(projectRoot, "plan.json"), reviewOutputFile: join(projectRoot, "codex-review.json"),
        exitType: "", exitNote: "", verdict: "AMEND", notes,
    };
}

test("test_main_writesTheNotesAndRaisesThePlanReviewCounterToOne", () => {
    const projectRoot = makeFixture();
    const output = main(JSON.stringify(packet(projectRoot, "fix the thing")));
    assert.equal(output.box, "UPDATE_TASKS_JSON");
    const tasks = JSON.parse(readFileSync(join(projectRoot, "tasks.json"), "utf8"));
    assert.equal(tasks[0].codexReviewNotes, "fix the thing");
    assert.equal(getAttemptCount(42, "planReview", projectRoot), 1);
});

test("test_main_raisesTheCounterByOneOnASecondCall", () => {
    const projectRoot = makeFixture();
    main(JSON.stringify(packet(projectRoot, "first pass")));
    main(JSON.stringify(packet(projectRoot, "second pass")));
    const tasks = JSON.parse(readFileSync(join(projectRoot, "tasks.json"), "utf8"));
    assert.equal(tasks[0].codexReviewNotes, "second pass");
    assert.equal(getAttemptCount(42, "planReview", projectRoot), 2);
});

test("test_main_throwsWhenTheTaskIsNotInTasksJson", () => {
    const projectRoot = makeFixture();
    const missingTaskPacket = { ...packet(projectRoot, "x"), taskNumber: 999 };
    assert.throws(() => main(JSON.stringify(missingTaskPacket)), /999/);
});

test("test_main_carriesRunIdAndBranchForward", () => {
    const projectRoot = makeFixture();
    const output = main(JSON.stringify(packet(projectRoot, "fix the thing")));
    assert.equal(output.runId, "run-1");
    assert.equal(output.branch, "main");
});
