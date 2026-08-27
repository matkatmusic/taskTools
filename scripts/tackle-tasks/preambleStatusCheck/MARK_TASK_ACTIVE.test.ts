// MARK_TASK_ACTIVE.ts: mark the task active. Mutating: uses a temp tasks.json, never the real one.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/MARK_TASK_ACTIVE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./MARK_TASK_ACTIVE.ts";
import { claimTask, readTaskRunState } from "../shared/taskRunState.ts";

function packet(taskNumber: number, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_TASK_ACTIVE_Q", scriptSignal: "continue", taskNumber, runId: "", projectRoot,
        worktree: "", branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "MARK_TASK_ACTIVE",
    });
}

function makeProjectRoot(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "MARK_TASK_ACTIVE-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(tasks));
    return root;
}

test("test_MARK_TASK_ACTIVE_marksTheTaskActiveInTasksJson", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const output = main(packet(1, root));
    assert.equal(output.box, "MARK_TASK_ACTIVE");
    assert.equal(typeof output.runId, "string");
    assert.notEqual(output.runId, "");
    assert.equal(readTaskRunState(1, root).active, true);
});

test("test_MARK_TASK_ACTIVE_throwsWhenTheTaskIsAlreadyActive", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    claimTask(1, "run-a", root);
    assert.throws(() => main(packet(1, root)), /could not be marked active/);
});
