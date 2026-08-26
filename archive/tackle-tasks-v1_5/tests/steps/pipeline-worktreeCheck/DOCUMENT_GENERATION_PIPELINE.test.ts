// Behavioral checks for scripts/steps/pipeline-worktreeCheck/DOCUMENT_GENERATION_PIPELINE.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/DOCUMENT_GENERATION_PIPELINE.ts";

test("test_DOCUMENT_GENERATION_PIPELINE_forwardsTheWorktreeAndDocsModeUnchanged", () => {
    const output = main(JSON.stringify({
        box: "INIT_SUBMODULES_RECURSIVELY", scriptSignal: "continue", taskNumber: 1, runId: "run-1",
        projectRoot: "/tmp/example-project", worktree: "/tmp/example-project-worktrees/task-1", branch: "task-1",
        docsMode: "UPDATE", exitType: "", exitNote: "",
    }));

    assert.equal(output.box, "DOCUMENT_GENERATION_PIPELINE");
    assert.equal(output.worktree, "/tmp/example-project-worktrees/task-1");
    assert.equal(output.docsMode, "UPDATE");
});
