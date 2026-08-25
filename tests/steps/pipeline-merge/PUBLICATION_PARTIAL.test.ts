// Behavioral checks for scripts/steps/pipeline-merge/PUBLICATION_PARTIAL.ts.
// Run: node --test tests/steps/pipeline-merge/PUBLICATION_PARTIAL.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/PUBLICATION_PARTIAL.ts";

test("test_PUBLICATION_PARTIAL_setsTheRecoveryOnlyExitTypeAndNote", () => {
    const packet = { worktreePath: "/wt", taskNumber: 7, runId: "run-1", projectRoot: "/proj" };
    const result = main(JSON.stringify(packet));
    assert.equal(result.box, "PUBLICATION_PARTIAL");
    assert.equal(result.next, "EXIT_WORKFLOW_MERGE");
    assert.equal(result.exitType, "partially-published");
    assert.equal(
        result.exitNote,
        "some layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.",
    );
});
