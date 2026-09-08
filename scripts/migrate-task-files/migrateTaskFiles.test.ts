// migrateTaskFiles.ts renames the legacy `files` key to `modifiableFiles` per the three rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateTaskFiles } from "./migrateTaskFiles.ts";

function makeTasksFile(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-migrate-"));
    const path = join(root, "tasks.json");
    writeFileSync(path, JSON.stringify(tasks, null, 2) + "\n");
    return path;
}

function readTasks(path: string): any[] {
    return JSON.parse(readFileSync(path, "utf8"));
}

test("files with no modifiableFiles: renames the key and keeps the list as-is", () => {
    const path = makeTasksFile([{ taskNumber: 1, files: ["a.ts", "b.ts"] }]);
    const changed = migrateTaskFiles(path);

    assert.deepEqual(changed, [1]);
    const task = readTasks(path)[0];
    assert.deepEqual(task.modifiableFiles, ["a.ts", "b.ts"]);
    assert.equal("files" in task, false);
});

test("modifiableFiles with no files: leaves the task untouched", () => {
    const path = makeTasksFile([{ taskNumber: 2, modifiableFiles: ["c.ts"] }]);
    const original = readFileSync(path, "utf8");
    const changed = migrateTaskFiles(path);

    assert.deepEqual(changed, []);
    assert.equal(readFileSync(path, "utf8"), original);
});

test("both keys present: keeps modifiableFiles as-is and drops files", () => {
    const path = makeTasksFile([{ taskNumber: 3, files: ["old.ts"], modifiableFiles: ["new.ts"] }]);
    const changed = migrateTaskFiles(path);

    assert.deepEqual(changed, [3]);
    const task = readTasks(path)[0];
    assert.deepEqual(task.modifiableFiles, ["new.ts"]);
    assert.equal("files" in task, false);
});

test("neither key present: leaves the task untouched and never adds readOnlyFiles", () => {
    const path = makeTasksFile([{ taskNumber: 4, title: "no files here" }]);
    const changed = migrateTaskFiles(path);

    assert.deepEqual(changed, []);
    const task = readTasks(path)[0];
    assert.equal("files" in task, false);
    assert.equal("modifiableFiles" in task, false);
    assert.equal("readOnlyFiles" in task, false);
});
