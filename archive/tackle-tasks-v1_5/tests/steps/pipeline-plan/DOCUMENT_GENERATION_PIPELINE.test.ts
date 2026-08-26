import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/DOCUMENT_GENERATION_PIPELINE.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };

test("test_DOCUMENT_GENERATION_PIPELINE_setsUpdateDocsModeAndCarriesTheClarifyRequest", () => {
    const output = main(JSON.stringify({ ...base, clarifyRequest: "which database?" }));
    assert.equal(output.docsMode, "UPDATE");
    assert.equal(output.clarifyRequest, "which database?");
});
