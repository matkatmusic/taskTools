// Behavioral checks for scripts/steps/pipeline-reviewPlan/UPDATE_TASK_ENTRY.ts. Mutating: runs only against a temp copy of the fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/UPDATE_TASK_ENTRY.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(import.meta.dirname, "../../../scripts/steps/pipeline-reviewPlan/UPDATE_TASK_ENTRY.template.json");

const FIXTURE_TASKS = [
    { taskNumber: 42, title: "Fixture task", codexReviewNotes: "", planReviewCount: 0 },
];

function makeFixture(): string {
    const taskStateRoot = mkdtempSync(join(tmpdir(), "update-task-entry-"));
    writeFileSync(join(taskStateRoot, "tasks.json"), JSON.stringify(FIXTURE_TASKS));
    writeFileSync(join(taskStateRoot, "completedTasks.json"), "[]");
    return taskStateRoot;
}

function packet(taskStateRoot: string, notes: string) {
    return {
        taskNumber: 42, taskStateRoot, repoRoot: taskStateRoot, notes,
        runId: "run-1", sourceBranch: "main",
    };
}

test("test_main_writesTheNotesAndSetsTheReviewCountToOne", () => {
    const taskStateRoot = makeFixture();

    const output = main(JSON.stringify(packet(taskStateRoot, "fix the thing")));

    assert.equal(output.box, "UPDATE_TASK_ENTRY");
    assert.equal(output.reviewCount, 1);
    const tasks = JSON.parse(readFileSync(join(taskStateRoot, "tasks.json"), "utf8"));
    assert.equal(tasks[0].codexReviewNotes, "fix the thing");
    assert.equal(tasks[0].planReviewCount, 1);
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_main_raisesTheCounterByOneOnASecondCall", () => {
    const taskStateRoot = makeFixture();
    main(JSON.stringify(packet(taskStateRoot, "first pass")));

    const output = main(JSON.stringify(packet(taskStateRoot, "second pass")));

    assert.equal(output.reviewCount, 2);
    const tasks = JSON.parse(readFileSync(join(taskStateRoot, "tasks.json"), "utf8"));
    assert.equal(tasks[0].codexReviewNotes, "second pass");
    assert.equal(tasks[0].planReviewCount, 2);
});

test("test_main_throwsWhenTheTaskIsNotInTasksJson", () => {
    const taskStateRoot = makeFixture();
    const missingTaskPacket = { ...packet(taskStateRoot, "x"), taskNumber: 999 };
    assert.throws(() => main(JSON.stringify(missingTaskPacket)), /999/);
});

test("test_main_carriesRunIdAndSourceBranchForward", () => {
    const taskStateRoot = makeFixture();
    const p = packet(taskStateRoot, "fix the thing");
    const output = main(JSON.stringify(p));
    assert.equal(output.runId, "run-1");
    assert.equal(output.sourceBranch, "main");
});
