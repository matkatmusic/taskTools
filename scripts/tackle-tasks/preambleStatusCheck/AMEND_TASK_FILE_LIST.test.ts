// AMEND_TASK_FILE_LIST.ts adds files outside the fence to tasks.json modifiableFiles. Run: node --test scripts/tackle-tasks/preambleStatusCheck/AMEND_TASK_FILE_LIST.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./AMEND_TASK_FILE_LIST.ts";

function makeProjectRoot(taskNumber: number): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "AMEND_TASK_FILE_LIST-"));
    mkdirSync(join(projectRoot, ".taskTools"));
    writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), `${JSON.stringify([{ taskNumber, title: "t", modifiableFiles: ["seed.txt"] }], null, 2)}\n`);
    return projectRoot;
}

function packet(taskNumber: number, projectRoot: string, violations: string[]): string {
    return JSON.stringify({
        box: "Q_DOES_FENCE_COVER_WORKTREE_Q", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot,
        worktree: "/abs/worktree", branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
        violations, next: "B_AMEND_TASK_FILE_LIST",
    });
}

function readModifiableFiles(projectRoot: string, taskNumber: number): unknown {
    const tasks = JSON.parse(readFileSync(join(projectRoot, ".taskTools", "tasks.json"), "utf8")) as { taskNumber: number; modifiableFiles: unknown }[];
    return tasks.find((task) => task.taskNumber === taskNumber)?.modifiableFiles;
}

test("test_B_AMEND_TASK_FILE_LIST_appendsEachViolationToTheTasksModifiableFiles", () => {
    const projectRoot = makeProjectRoot(900_501);

    const output = main(packet(900_501, projectRoot, ["outside.txt"]));

    assert.deepEqual(readModifiableFiles(projectRoot, 900_501), ["seed.txt", "outside.txt"]);
    assert.equal(output.box, "B_AMEND_TASK_FILE_LIST");
    assert.equal(output.docsMode, "UPDATE");
    assert.equal("next" in output, false);
});

test("test_B_AMEND_TASK_FILE_LIST_dedupesAViolationTheTaskAlreadyDeclares", () => {
    const projectRoot = makeProjectRoot(900_502);

    main(packet(900_502, projectRoot, ["seed.txt"]));

    assert.deepEqual(readModifiableFiles(projectRoot, 900_502), ["seed.txt"]);
});
