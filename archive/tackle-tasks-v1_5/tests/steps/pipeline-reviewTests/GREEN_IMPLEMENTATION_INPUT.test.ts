// Behavioral checks for scripts/steps/pipeline-reviewTests/GREEN_IMPLEMENTATION_INPUT.ts. Run: node --test tests/steps/pipeline-reviewTests/GREEN_IMPLEMENTATION_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewTests/GREEN_IMPLEMENTATION_INPUT.ts";

const packet = {
    projectRoot: "/abs/project", taskNumber: 99, worktreePath: "/abs/project/worktree", sourceBranch: "main", runId: "run-1",
};

test("test_main_forwardsEveryPacketFieldUnchanged", () => {
    const output = main(JSON.stringify(packet));
    assert.equal(output.box, "GREEN_IMPLEMENTATION_INPUT");
    assert.equal(output.scriptSignal, "continue");
    for (const [key, value] of Object.entries(packet)) assert.deepEqual(output[key], value);
});

test("test_main_throwsWhenProjectRootIsNotAbsolute", () => {
    assert.throws(() => main(JSON.stringify({ ...packet, projectRoot: "relative/path" })), /absolute/);
});

test("test_main_throwsWhenTaskNumberIsMissing", () => {
    const { taskNumber: _taskNumber, ...rest } = packet;
    assert.throws(() => main(JSON.stringify(rest)), /taskNumber is required/);
});

test("test_main_throwsWhenSourceBranchIsEmpty", () => {
    assert.throws(() => main(JSON.stringify({ ...packet, sourceBranch: "" })), /sourceBranch is required/);
});

test("test_main_throwsWhenRunIdIsEmpty", () => {
    assert.throws(() => main(JSON.stringify({ ...packet, runId: "" })), /runId is required/);
});
