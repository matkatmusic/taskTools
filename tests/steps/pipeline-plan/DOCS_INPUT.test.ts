import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/DOCS_INPUT.ts";

const packet = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", branch: "master", projectRoot: "/tmp/fake-project" };

test("test_DOCS_INPUT_forwardsRunIdentityUnchanged", () => {
    const output = main(JSON.stringify(packet));
    assert.equal(output.box, "DOCS_INPUT");
    assert.equal(output.scriptSignal, "continue");
    assert.deepEqual(output, {
        box: "DOCS_INPUT", scriptSignal: "continue",
        taskNumber: packet.taskNumber, runId: packet.runId, worktree: packet.worktree,
        sourceBranch: packet.branch, projectRoot: packet.projectRoot,
    });
});
