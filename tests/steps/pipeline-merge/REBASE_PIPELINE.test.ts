// Behavioral checks for scripts/steps/pipeline-merge/REBASE_PIPELINE.ts.  Run: node --test tests/steps/pipeline-merge/REBASE_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/REBASE_PIPELINE.ts";

test("test_REBASE_PIPELINE_reshapesTheMergePacketForRebase", () => {
    const packet = {
        worktreePath: "/wt", rootSourceBranch: "main", taskNumber: 7, runId: "run-1", projectRoot: "/proj",
        suiteFixAttempts: 2, landed: ["root", "sub"], state: "SOME LANDED", notLanded: ["sub2"], commits: [],
    };
    const result = main(JSON.stringify(packet));
    assert.deepEqual(result, {
        box: "REBASE_PIPELINE", scriptSignal: "continue",
        projectRoot: "/proj", worktreePath: "/wt", taskNumber: 7, runId: "run-1",
        stepId: "rebase", rootSourceBranch: "main", landedOccurrenceIds: ["root", "sub"], suiteFixAttempts: 2,
    });
});
