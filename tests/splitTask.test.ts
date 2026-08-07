import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeParentTask,
    composeClosureNote,
    parseFileGroups,
    partitionFiles,
    readParentTask,
    validateChildNumbers,
    validateFileGroups,
    verifyChildFiles,
} from "../scripts/splitTask.ts";

function writeTaskFiles(root: string, tasks: unknown[], completed: unknown[]): void {
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), JSON.stringify(completed, null, 2) + "\n");
}

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "split-task-"));
    const parentTask = {
        taskNumber: 58,
        title: "Big task",
        description: "desc",
        files: ["a.ts", "b.ts", "c.ts", "d.ts"],
    };
    const childTaskA = { taskNumber: 66, title: "Child A", description: "desc", files: ["a.ts", "b.ts"] };
    const childTaskB = { taskNumber: 67, title: "Child B", description: "desc", files: ["c.ts", "d.ts"] };
    const closedTask = { taskNumber: 40, title: "Already closed", description: "desc" };
    writeTaskFiles(root, [parentTask, childTaskA, childTaskB], [closedTask]);
    return root;
}

function readTasks(root: string): any[] {
    return JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"));
}

function readCompleted(root: string): any[] {
    return JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
}

test("readParentTask loads the parent by number", () => {
    const root = makeProjectRoot();
    const parent = readParentTask(58, root);
    assert.equal(parent.taskNumber, 58);
    assert.deepEqual(parent.files, ["a.ts", "b.ts", "c.ts", "d.ts"]);
});

test("readParentTask throws when the task number does not exist", () => {
    const root = makeProjectRoot();
    assert.throws(() => readParentTask(999, root));
});

test("readParentTask throws when the task is already closed", () => {
    const root = makeProjectRoot();
    assert.throws(() => readParentTask(40, root));
});

test("partitionFiles splits contiguously into near-equal groups", () => {
    assert.deepEqual(partitionFiles(["a.ts", "b.ts", "c.ts", "d.ts"], 2), [["a.ts", "b.ts"], ["c.ts", "d.ts"]]);
    assert.deepEqual(partitionFiles(["a.ts", "b.ts", "c.ts"], 2), [["a.ts", "b.ts"], ["c.ts"]]);
});

test("partitionFiles throws when there are fewer files than splits", () => {
    assert.throws(() => partitionFiles(["a.ts"], 2));
});

test("partitionFiles throws when numSplits is less than 2", () => {
    assert.throws(() => partitionFiles(["a.ts", "b.ts"], 1));
});

test("validateFileGroups passes when groups exactly partition the parent's files", () => {
    assert.doesNotThrow(() =>
        validateFileGroups(["a.ts", "b.ts", "c.ts", "d.ts"], [["a.ts", "b.ts"], ["c.ts", "d.ts"]]),
    );
});

test("validateFileGroups throws when a parent file is missing from every group", () => {
    assert.throws(() => validateFileGroups(["a.ts", "b.ts", "c.ts"], [["a.ts"], ["b.ts"]]));
});

test("validateFileGroups throws when a group claims a file the parent doesn't have", () => {
    assert.throws(() => validateFileGroups(["a.ts", "b.ts"], [["a.ts"], ["b.ts", "z.ts"]]));
});

test("validateFileGroups throws when a file is assigned to more than one child", () => {
    assert.throws(() => validateFileGroups(["a.ts", "b.ts"], [["a.ts", "b.ts"], ["b.ts"]]));
});

test("validateFileGroups reports every violation category in one error, not just the first", () => {
    assert.throws(
        () => validateFileGroups(["a.ts", "b.ts", "c.ts"], [["a.ts", "a.ts"], ["z.ts"]]),
        (error: Error) =>
            error.message.includes("assigned to more than one child") &&
            error.message.includes("not in the parent's files array") &&
            error.message.includes("missing from every child group"),
    );
});

test("composeClosureNote formats child numbers", () => {
    assert.equal(composeClosureNote([66, 67, 68]), "Split into 66, 67, 68");
});

test("validateChildNumbers passes for the right count of distinct open children", () => {
    const root = makeProjectRoot();
    assert.doesNotThrow(() => validateChildNumbers([66, 67], 2, 58, root));
});

test("validateChildNumbers throws when the count does not match numSplits", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66], 2, 58, root));
});

test("validateChildNumbers throws on a duplicate child number", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66, 66], 2, 58, root));
});

test("validateChildNumbers throws when a child equals the parent number", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([58, 66], 2, 58, root));
});

test("validateChildNumbers throws when a child is not an open task", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66, 999], 2, 58, root));
});

test("validateChildNumbers throws when a child is already closed", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66, 40], 2, 58, root));
});

test("verifyChildFiles passes when the child's files exactly match its assigned group", () => {
    const root = makeProjectRoot();
    assert.doesNotThrow(() => verifyChildFiles(66, ["a.ts", "b.ts"], root));
});

test("verifyChildFiles throws when the child's files differ from its assigned group", () => {
    const root = makeProjectRoot();
    assert.throws(() => verifyChildFiles(67, ["c.ts", "d.ts", "e.ts"], root));
});

test("closeParentTask closes the parent and moves it to completedTasks.json", () => {
    const root = makeProjectRoot();
    const result = closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts"], ["c.ts", "d.ts"]], root);
    assert.deepEqual(result.closed, [58]);

    const completed = readCompleted(root);
    const closedParent = completed.find((task: { taskNumber: number }) => task.taskNumber === 58);
    assert.equal(closedParent.closureNote, "Split into 66, 67");

    const open = readTasks(root).map((task: { taskNumber: number }) => task.taskNumber).sort();
    assert.deepEqual(open, [66, 67]);
});

test("closeParentTask throws and leaves the parent open when child numbers are invalid", () => {
    const root = makeProjectRoot();
    assert.throws(() => closeParentTask(58, 2, [66, 999], [["a.ts", "b.ts"], ["c.ts", "d.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("closeParentTask throws and leaves the parent open when a child omits a file from its assigned group", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts", "c.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts"] },
            { taskNumber: 67, title: "Child B", files: ["c.ts"] },
        ],
        [],
    );
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts"], ["c.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("closeParentTask throws and leaves the parent open when a child claims a file outside its assigned group", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts", "z.ts"] },
            { taskNumber: 67, title: "Child B", files: ["b.ts"] },
        ],
        [],
    );
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts"], ["b.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("closeParentTask throws and leaves the parent open when a child's files drifted from its assigned group", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts", "b.ts", "z.ts"] },
            { taskNumber: 67, title: "Child B", files: ["c.ts", "d.ts"] },
        ],
        [],
    );
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts"], ["c.ts", "d.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("closeParentTask succeeds with a non-contiguous file grouping that fully partitions the parent's files", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts", "c.ts"] },
            { taskNumber: 67, title: "Child B", files: ["b.ts", "d.ts"] },
        ],
        [],
    );
    const result = closeParentTask(58, 2, [66, 67], [["a.ts", "c.ts"], ["b.ts", "d.ts"]], root);
    assert.deepEqual(result.closed, [58]);
});

test("closeParentTask throws when the number of file groups doesn't match numSplits", () => {
    const root = makeProjectRoot();
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts", "c.ts", "d.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("parseFileGroups decodes valid JSON and rejects malformed or wrongly-shaped input", () => {
    assert.deepEqual(parseFileGroups('[["a.ts","b.ts"],["c.ts"]]'), [["a.ts", "b.ts"], ["c.ts"]]);
    assert.throws(() => parseFileGroups("not json"));
    assert.throws(() => parseFileGroups('[["a.ts"], "b.ts"]'));
});

test("SKILL.md advertises the guidance argument and extracts it via $ARGUMENTS, not the truncating $3", () => {
    const skillMd = readFileSync(join(import.meta.dirname, "..", "skills", "split-task", "SKILL.md"), "utf8");
    assert.match(skillMd, /argument-hint: "<taskNum> <numSplits> \[guidance\]"/);
    assert.match(skillMd, /\$ARGUMENTS/);
    assert.doesNotMatch(skillMd, /\$3/);
});
