// Behavioral checks for scripts/steps/pipeline-rebase/SOURCE_REPO_LOCKED_INPUT.ts.  Run: node --test tests/steps/pipeline-rebase/SOURCE_REPO_LOCKED_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebase/SOURCE_REPO_LOCKED_INPUT.ts";

test("test_SOURCE_REPO_LOCKED_INPUT_buildsTheClosedPacketFromTheDiagramsDeclaredInput", () => {
    const input = JSON.stringify({
        projectRoot: "/repo", worktreePath: "/repo/.worktrees/task-1", taskNumber: 1,
        runId: "run-1", stepId: "step-1", rootSourceBranch: "main", landedOccurrenceIds: ["child"],
        suiteFixAttempts: 0,
    });

    const output = main(input);

    assert.equal(output.box, "SOURCE_REPO_LOCKED_INPUT");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.worktreePath, "/repo/.worktrees/task-1");
    assert.equal(output.rootSourceBranch, "main");
    assert.deepEqual(output.landedOccurrenceIds, ["child"]);
    assert.equal(output.suiteFixAttempts, 0);
    assert.equal(output.conflicted, false);
    assert.equal(output.stoppedOccurrenceId, "");
    assert.equal(output.stoppedCheckoutPath, "");
    assert.deepEqual(output.conflictedFilePaths, []);
    assert.equal(output.finished, false);
    assert.equal(output.failureReason, "");
    assert.equal(output.exitType, "");
    assert.equal(output.exitNote, "");
});
