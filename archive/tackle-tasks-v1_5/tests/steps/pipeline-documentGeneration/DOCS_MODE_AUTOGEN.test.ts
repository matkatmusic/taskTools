// Behavioral check for DOCS_MODE_AUTOGEN.ts. Run alone: node --test tests/steps/pipeline-documentGeneration/DOCS_MODE_AUTOGEN.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-documentGeneration/DOCS_MODE_AUTOGEN.ts";

test("test_DOCS_MODE_AUTOGEN_passesThePacketThrough", () => {
    const input = { box: "WHAT_IS_DOCS_MODE", scriptSignal: "continue", next: "DOCS_MODE_AUTOGEN", worktree: "/repo/worktrees/task-9", taskNumber: 9, projectRoot: "/repo", docsMode: "AUTOGEN", clarifyRequest: "" };

    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { box: "DOCS_MODE_AUTOGEN", scriptSignal: "continue", worktree: "/repo/worktrees/task-9", taskNumber: 9, projectRoot: "/repo", docsMode: "AUTOGEN", clarifyRequest: "" });
});
