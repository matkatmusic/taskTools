// Behavioral check for PLAN_PIPELINE.ts, the hand-off leaf into pipeline-plan.mmd::DOCS_INPUT.  Run alone: node --test tests/steps/pipeline-documentGeneration/PLAN_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-documentGeneration/PLAN_PIPELINE.ts";

// Downstream pipeline-plan.mmd::DOCS_INPUT needs runId and worktree, so the hand-off must carry the whole docs packet.
test("test_PLAN_PIPELINE_forwardsTheDocsPacket", () => {
    const input = { box: "AUTO_GENERATE_DOCS", scriptSignal: "continue", taskNumber: 9, runId: "run-9", projectRoot: "/repo", worktree: "/repo/worktrees/task-9", branch: "task-9", docsMode: "AUTOGEN", exitType: "", exitNote: "", clarifyRequest: "", briefFile: "/repo/worktrees/task-9/plans/brief-9.md" };

    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...input, box: "PLAN_PIPELINE", scriptSignal: "continue" });
});
