import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { formatReport, rateAndPersist } from "../scripts/rate-task/rateTask.ts";
import type { TaskRecord } from "../scripts/shared/taskFiles.ts";

const sprawlingTask: TaskRecord = {
    taskNumber: 1,
    title: "Sprawling multi-subsystem task",
    description: [
        "Rework the entire pipeline across several subsystems.",
        "- update the source logic",
        "- update the tests",
        "- update the docs",
        "- update the CLI scripts",
    ].join("\n"),
    modifiableFiles: ["src/foo.ts", "tests/foo.test.ts", "docs/foo.md", "scripts/bar.ts"],
};

const mechanicalTask: TaskRecord = {
    taskNumber: 2,
    title: "One-line mechanical task",
    description: "Rename variable x to y.",
    modifiableFiles: ["src/foo.ts"],
};

const hardAtomicTask: TaskRecord = {
    taskNumber: 3,
    title: "Hard but atomic task",
    description: [
        "Rework the internal state machine in this one file; the transition table interactions are subtle.",
        "- handle the retry-after-timeout edge case",
        "- handle the concurrent-cancel edge case",
        "- handle the partial-write edge case",
    ].join("\n"),
    modifiableFiles: ["src/stateMachine.ts"],
};

const thresholdTask: TaskRecord = {
    taskNumber: 4,
    title: "Two related tweaks to one module",
    description: ["Update the module in two ways.", "- adjust the parser", "- adjust the formatter"].join("\n"),
    modifiableFiles: ["src/foo.ts", "src/bar.ts"],
};

function writeFixture(tasks: TaskRecord[]): string {
    const root = mkdtempSync(join(tmpdir(), "rateTask-"));
    const taskToolsDir = join(root, ".taskTools");
    mkdirSync(taskToolsDir, { recursive: true });
    writeFileSync(join(taskToolsDir, "tasks.json"), JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(join(taskToolsDir, "completedTasks.json"), "[]\n");
    return root;
}

test("rates a sprawling multi-subsystem task as split-worthy with named split points", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const [result] = rateAndPersist(root, [1]);
    assert.equal(result.taskNumber, 1);
    assert.ok(result.splitWorthiness >= 6, `expected split-worthiness >= 6, got ${result.splitWorthiness}`);
    assert.ok(result.splitPoints.length >= 2, `expected at least two split points, got ${result.splitPoints.length}`);
});

test("rates a one-line mechanical task as not split-worthy with no split points", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const [result] = rateAndPersist(root, [2]);
    assert.equal(result.taskNumber, 2);
    assert.ok(result.splitWorthiness < 6, `expected split-worthiness < 6, got ${result.splitWorthiness}`);
    assert.equal(result.splitPoints.length, 0);
});

test("a hard but atomic task scores high difficulty without inflating split-worthiness", () => {
    const root = writeFixture([hardAtomicTask]);
    const [result] = rateAndPersist(root, [3]);
    assert.ok(result.difficulty >= 7, `expected difficulty >= 7, got ${result.difficulty}`);
    assert.ok(result.splitWorthiness < 5, `expected split-worthiness < 5, got ${result.splitWorthiness}`);
    assert.equal(result.splitPoints.length, 0);
});

test("split-worthiness at exactly the threshold still emits at least two split points", () => {
    const root = writeFixture([thresholdTask]);
    const [result] = rateAndPersist(root, [4]);
    assert.equal(result.splitWorthiness, 5);
    assert.ok(result.splitPoints.length >= 2, `expected at least two split points, got ${result.splitPoints.length}`);
});

test("split-worthiness of 5 or more always comes with at least two split points", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask, hardAtomicTask, thresholdTask]);
    const results = rateAndPersist(root, []);
    for (const result of results) {
        if (result.splitWorthiness >= 5) {
            assert.ok(result.splitPoints.length >= 2, `task ${result.taskNumber}: score ${result.splitWorthiness} but only ${result.splitPoints.length} points`);
        }
    }
});

test("report includes a paste-ready split-task command matching the point count", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const results = rateAndPersist(root, [1]);
    const [result] = results;
    const report = formatReport(results);
    assert.ok(
        report.includes(`/split-task ${result.taskNumber} ${result.splitPoints.length} ${result.splitPoints.join(" | ")}`),
        `report did not include a matching /split-task command:\n${report}`,
    );
});

test("persists both scores onto the task records without disturbing other fields", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const originals = new Map([sprawlingTask, mechanicalTask].map((t) => [t.taskNumber, t]));
    const results = rateAndPersist(root, [1, 2]);
    assert.equal(results.length, 2);
    const persisted: TaskRecord[] = JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"));
    for (const result of results) {
        const original = originals.get(result.taskNumber)!;
        const task = persisted.find((t) => t.taskNumber === result.taskNumber);
        assert.ok(task, `task ${result.taskNumber} missing after persist`);
        assert.equal(task!.difficulty, result.difficulty);
        assert.equal(task!.splitWorthiness, result.splitWorthiness);
        assert.equal(task!.title, original.title);
        assert.deepEqual(task!.files, original.files);
    }
});

test("rating with no task numbers rates every open task", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const results = rateAndPersist(root, []);
    assert.deepEqual(results.map((r) => r.taskNumber).sort(), [1, 2]);
});
