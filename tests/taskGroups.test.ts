// Behavioral checks for taskGroups.ts: pure file-overlap grouping, no I/O.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredFiles, groupTasksByFileOverlap, readOnlyFilesOf } from "../scripts/taskGroups.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "../scripts/taskFiles.ts";
import type { RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function task(taskNumber: number, files?: string[]): TaskRecord {
    return files === undefined ? { taskNumber } : { taskNumber, files };
}

const flatManifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [
        {
            occurrenceId: "flat",
            checkoutPath: "",
            parentOccurrenceId: null,
            pathInParent: null,
            gitlinkOid: null,
            depth: 0,
            originUrl: "https://local/flat/flat.git",
            baseBranch: "main",
            baseOid: "0".repeat(40),
            operationBranch: "main",
            childOccurrenceIds: [],
            testState: "untested",
        },
    ],
};

test("test_groupTasksByFileOverlapPutsTasksSharingAFileInOneGroup", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])], flatManifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_groupTasksByFileOverlapSeparatesTasksWithNoSharedFile", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileB"])], flatManifest);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.taskNumbers), [[1], [2]]);
});

test("test_groupTasksByFileOverlapJoinsTasksLinkedThroughAThirdTask", () => {
    const groups = groupTasksByFileOverlap([
        task(1, ["fileA"]),
        task(2, ["fileB"]),
        task(3, ["fileA", "fileB"]),
    ], flatManifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2, 3]);
});

test("test_groupTasksByFileOverlapPutsTasksWithoutDeclaredFilesInTheUnknownGroup", () => {
    const groups = groupTasksByFileOverlap([task(1), task(2), task(3, ["fileA"])], flatManifest);
    assert.equal(groups.length, 2);
    const unknownGroup = groups.find((g) => g.scope === "unknown");
    const declaredGroup = groups.find((g) => g.scope === "declared");
    assert.deepEqual(unknownGroup?.taskNumbers, [1, 2]);
    assert.deepEqual(declaredGroup?.taskNumbers, [3]);
});

test("test_groupTasksByFileOverlapOrdersGroupsAndTaskNumbersAscending", () => {
    const groups = groupTasksByFileOverlap([
        task(9, ["fileB"]),
        task(3, ["fileA"]),
        task(5, ["fileB"]),
    ], flatManifest);
    assert.equal(groups[0].taskNumbers[0], 3);
    const groupWithNine = groups.find((g) => g.taskNumbers.includes(9));
    assert.deepEqual(groupWithNine?.taskNumbers, [5, 9]);
});

test("test_groupTasksByFileOverlapStillWorksWithNoManifestArgument", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_declaredFilesReturnsModifiableFilesWhenTheTaskDeclaresIt", () => {
    assert.deepEqual(declaredFiles({ taskNumber: 1, modifiableFiles: ["a.ts"], files: ["legacy.ts"] } as TaskRecord), ["a.ts"]);
});

test("test_declaredFilesFallsBackToFilesWhenModifiableFilesIsAbsent", () => {
    assert.deepEqual(declaredFiles({ taskNumber: 1, files: ["a.ts"] } as TaskRecord), ["a.ts"]);
});

test("test_declaredFilesReturnsEmptyArrayWhenTheTaskDeclaresNeitherKey", () => {
    assert.deepEqual(declaredFiles({ taskNumber: 1 } as TaskRecord), []);
});

test("test_readOnlyFilesOfDefaultsToWildcardWhenAbsent", () => {
    assert.deepEqual(readOnlyFilesOf({ taskNumber: 1, files: ["a.ts"] } as TaskRecord), ["*"]);
});

test("test_readOnlyFilesOfReturnsTheDeclaredListWhenPresent", () => {
    assert.deepEqual(readOnlyFilesOf({ taskNumber: 1, readOnlyFiles: ["b.ts"] } as TaskRecord), ["b.ts"]);
});

test("test_groupTasksByFileOverlapGroupsATaskDeclaringModifiableFilesWithALegacyTaskSharingTheSameFile", () => {
    const legacyTask: TaskRecord = { taskNumber: 1, files: ["fileA"] };
    const modernTask = { taskNumber: 2, modifiableFiles: ["fileA"] } as TaskRecord;
    const groups = groupTasksByFileOverlap([legacyTask, modernTask], flatManifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_tasksJsonEveryEntryHasReadOnlyFilesAndModifiableFilesAndNoFilesKey", () => {
    const tasksPath = join(import.meta.dirname, "..", ".taskTools", "tasks.json");
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    for (const task of tasks) {
        assert.equal(Array.isArray(task.modifiableFiles), true, `task ${task.taskNumber} is missing modifiableFiles`);
        assert.equal(Array.isArray(task.readOnlyFiles), true, `task ${task.taskNumber} is missing readOnlyFiles`);
        assert.equal("files" in task, false, `task ${task.taskNumber} still has a files key`);
    }
});
