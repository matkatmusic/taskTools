// Behavioral check for WORKTREE_DOCS_MODE_INPUT.ts. Run alone: node --test tests/steps/pipeline-documentGeneration/WORKTREE_DOCS_MODE_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-documentGeneration/WORKTREE_DOCS_MODE_INPUT.ts";

test("test_WORKTREE_DOCS_MODE_INPUT_passesThePacketThrough", () => {
    const packet = { worktree: "/repo/worktrees/task-9", taskNumber: 9, projectRoot: "/repo", docsMode: "AUTOGEN", clarifyRequest: "" };

    const output = main(JSON.stringify(packet));

    assert.deepEqual(output, { box: "WORKTREE_DOCS_MODE_INPUT", scriptSignal: "continue", ...packet });
});
