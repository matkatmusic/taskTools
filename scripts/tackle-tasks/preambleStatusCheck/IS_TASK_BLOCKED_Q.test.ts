// IS_TASK_BLOCKED_Q.ts is "is the task blocked?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/IS_TASK_BLOCKED_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./IS_TASK_BLOCKED_Q.ts";

function packet(taskNumber: number, projectRoot: string): string {
    return JSON.stringify({
        box: "PREAMBLE_STATUS_CHECK", scriptSignal: "continue", taskNumber, runId: "", projectRoot,
        worktree: "", branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "IS_TASK_BLOCKED_Q",
    });
}

function makeProjectRoot(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "IS_TASK_BLOCKED_Q-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(tasks));
    return root;
}

test("test_IS_TASK_BLOCKED_Q_exitsWhenBlockedByNamesAnOpenTask", () => {
    const root = makeProjectRoot([
        { taskNumber: 1, blockedBy: [{ taskNum: 2, reason: "needs schema" }] },
        { taskNumber: 2 },
    ]);
    const output = main(packet(1, root));
    assert.equal(output.next, "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT");
    assert.equal(output.exitType, "blocked");
    assert.equal(output.exitNote, "an open blocker remains");
});

test("test_IS_TASK_BLOCKED_Q_continuesToIsTaskActiveWhenTheBlockerIsNotOpen", () => {
    const root = makeProjectRoot([{ taskNumber: 1, blockedBy: [{ taskNum: 2, reason: "needs schema" }] }]);
    const output = main(packet(1, root));
    assert.equal(output.next, "IS_TASK_ACTIVE_Q");
    assert.equal(output.exitType, "");
});

test("test_IS_TASK_BLOCKED_Q_continuesToIsTaskActiveWhenThereIsNoBlockedByField", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const output = main(packet(1, root));
    assert.equal(output.next, "IS_TASK_ACTIVE_Q");
    assert.equal(output.exitType, "");
});
