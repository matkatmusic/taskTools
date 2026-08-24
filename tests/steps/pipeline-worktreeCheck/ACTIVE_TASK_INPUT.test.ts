// Behavioral checks for scripts/steps/pipeline-worktreeCheck/ACTIVE_TASK_INPUT.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/ACTIVE_TASK_INPUT.ts";

test("test_ACTIVE_TASK_INPUT_seedsThePacketWithTheDerivedBranchAndEmptyWorktree", () => {
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile: "/tmp/example-project/tasks.json", runId: "run-1" }));

    assert.equal(output.box, "ACTIVE_TASK_INPUT");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 1);
    assert.equal(output.runId, "run-1");
    assert.equal(output.projectRoot, "/tmp/example-project");
    assert.equal(output.worktree, "");
    assert.equal(output.branch, "task-1");
    assert.equal(output.docsMode, "");
    assert.equal(output.exitType, "");
    assert.equal(output.exitNote, "");
});
