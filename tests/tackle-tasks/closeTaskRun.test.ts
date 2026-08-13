// Behavioral checks for scripts/tackle-tasks/closeTaskRun.ts.
// Run: node --test tests/tackle-tasks/closeTaskRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTaskRun } from "../../scripts/tackle-tasks/closeTaskRun.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";

function makeProjectRoot(tasks: unknown[], completed: unknown[] = []): string {
    const root = mkdtempSync(join(tmpdir(), "closeTaskRun-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    writeFileSync(join(root, "completedTasks.json"), `${JSON.stringify(completed, null, 2)}\n`);
    return root;
}

test("test_closeTaskRun_archivesAndUnblocksInOneCall", () => {
    // Setup: task 1 is done and about to close; task 2 is blocked on task 1.
    const root = makeProjectRoot([
        { taskNumber: 1, title: "finished" },
        { taskNumber: 2, title: "waiting", blockedBy: [{ taskNum: 1, reason: "needs 1 first" }] },
    ]);

    // Test action: close task 1 in one call.
    const output = closeTaskRun({
        taskNumbers: [1],
        closureNote: "Task 1 completed.",
        projectRoot: root,
        commitHashes: ["abc123"],
    });

    // Verification: closed/skipped/unblocked all come back from the one call, task 1 is
    // archived, and task 2 no longer lists it as a blocker.
    assert.deepEqual(output, { closed: [1], skipped: [], unblocked: [2] });
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    const remaining = JSON.parse(readFileSync(tasksPath, "utf8"));
    const completed = JSON.parse(readFileSync(completedTasksPath, "utf8"));
    assert.deepEqual(remaining.map((t: any) => t.taskNumber), [2]);
    assert.equal(remaining[0].blockedBy, undefined);
    assert.equal(completed[0].taskNumber, 1);
    assert.equal(completed[0].closureNote, "Task 1 completed.");
    assert.deepEqual(completed[0].commitHashes, ["abc123"]);
});
