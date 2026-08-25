// Behavioral checks for scripts/steps/pipeline-suite/MERGE_PIPELINE.ts.  Run: node --test tests/steps/pipeline-suite/MERGE_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-suite/MERGE_PIPELINE.ts";

test("test_MERGE_PIPELINE_forwardsTheWorktreeIdentityAndTheSuiteFixAttemptCounter", () => {
    const input = JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktreePath: "/worktree", rootSourceBranch: "main",
        ownedFilePaths: [], testFilePaths: [], suiteFixAttempts: 1, output: "",
        next: "MERGE_PIPELINE", exitType: "", exitNote: "",
    });
    const output = main(input);

    assert.equal(output.box, "MERGE_PIPELINE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 1);
    assert.equal(output.worktreePath, "/worktree");
    assert.equal(output.suiteFixAttempts, 1);
    assert.equal("exitType" in output, false);
    assert.equal("ownedFilePaths" in output, false);
});
