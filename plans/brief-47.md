# Task 47: Swap taskGroups grouping onto canonicalTaskGroups

Step 2 of the task 35 cutover split.

Replace groupTasksByFileOverlap in scripts/taskGroups.ts with scripts/canonicalTaskGroups.ts buildCanonicalTaskGroups. buildCanonicalTaskGroups requires a RepositoryManifest argument that groupTasksByFileOverlap does not take, so it depends on the manifest bootstrap from task 45 and the wiring from task 46.

Find every importer of groupTasksByFileOverlap before changing its signature and update them together, or keep the old export as a thin adapter if a caller cannot be migrated in this task — say which in the plan.

Tests: existing tests/taskGroups.test.ts and tests/canonicalTaskGroups.test.ts both keep passing; file-disjoint grouping produces the same groups as before for the flat single-repository case.

### scripts/taskGroups.ts

```
// Groups tasks by shared file paths so disjoint groups can run in parallel. No-file tasks share one "unknown" group.
import type { TaskRecord } from "./taskFiles.ts";

export type TaskGroupScope = "declared" | "unknown";

export type TaskGroup = {
    groupId: number;
    taskNumbers: number[];
    filePaths: string[];
    scope: TaskGroupScope;
};

export function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

function findRoot(parent: Map<number, number>, taskNumber: number): number {
    let root = taskNumber;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
}

function union(parent: Map<number, number>, a: number, b: number): void {
    const rootA = findRoot(parent, a);
    const rootB = findRoot(parent, b);
    if (rootA !== rootB) parent.set(rootA, rootB);
}

export function groupTasksByFileOverlap(tasks: TaskRecord[]): TaskGroup[] {
    const parent = new Map<number, number>();
    for (const task of tasks) parent.set(task.taskNumber, task.taskNumber);

    const unknownTaskNumbers = tasks.filter((t) => declaredFiles(t).length === 0).map((t) => t.taskNumber);
    for (const taskNumber of unknownTaskNumbers.slice(1)) {
        union(parent, unknownTaskNumbers[0], taskNumber);
    }

    const lastTaskWithFile = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) {
            const owner = lastTaskWithFile.get(file);
            if (owner !== undefined) union(parent, owner, task.taskNumber);
            lastTaskWithFile.set(file, task.taskNumber);
        }
    }

    const byRoot = new Map<number, TaskRecord[]>();
    for (const task of tasks) {
        const root = findRoot(parent, task.taskNumber);
        const bucket = byRoot.get(root) ?? [];
        bucket.push(task);
        byRoot.set(root, bucket);
    }

    const groups: TaskGroup[] = [...byRoot.values()].map((groupTasks) => {
        const taskNumbers = groupTasks.map((t) => t.taskNumber).sort((a, b) => a - b);
        const filePaths = [...new Set(groupTasks.flatMap(declaredFiles))].sort();
        const scope: TaskGroupScope = filePaths.length > 0 ? "declared" : "unknown";
        return { groupId: 0, taskNumbers, filePaths, scope };
    });

    groups.sort((a, b) => a.taskNumbers[0] - b.taskNumbers[0]);
    return groups.map((group, index) => ({ ...group, groupId: index + 1 }));
}

```

### tests/taskGroups.test.ts

```
// Behavioral checks for taskGroups.ts: pure file-overlap grouping, no I/O.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTasksByFileOverlap } from "../scripts/taskGroups.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";

function task(taskNumber: number, files?: string[]): TaskRecord {
    return files === undefined ? { taskNumber } : { taskNumber, files };
}

test("test_groupTasksByFileOverlapPutsTasksSharingAFileInOneGroup", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_groupTasksByFileOverlapSeparatesTasksWithNoSharedFile", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileB"])]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.taskNumbers), [[1], [2]]);
});

test("test_groupTasksByFileOverlapJoinsTasksLinkedThroughAThirdTask", () => {
    const groups = groupTasksByFileOverlap([
        task(1, ["fileA"]),
        task(2, ["fileB"]),
        task(3, ["fileA", "fileB"]),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2, 3]);
});

test("test_groupTasksByFileOverlapPutsTasksWithoutDeclaredFilesInTheUnknownGroup", () => {
    const groups = groupTasksByFileOverlap([task(1), task(2), task(3, ["fileA"])]);
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
    ]);
    assert.equal(groups[0].taskNumbers[0], 3);
    const groupWithNine = groups.find((g) => g.taskNumbers.includes(9));
    assert.deepEqual(groupWithNine?.taskNumbers, [5, 9]);
});

```
