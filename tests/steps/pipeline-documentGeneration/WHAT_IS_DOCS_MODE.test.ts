// Behavioral check for WHAT_IS_DOCS_MODE.ts. Run alone: node --test tests/steps/pipeline-documentGeneration/WHAT_IS_DOCS_MODE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-documentGeneration/WHAT_IS_DOCS_MODE.ts";

test("test_WHAT_IS_DOCS_MODE_choosesTheAutogenArmForAutogenMode", () => {
    const packet = { worktree: "/repo/worktrees/task-9", taskNumber: 9, projectRoot: "/repo", docsMode: "AUTOGEN", clarifyRequest: "" };

    const output = main(JSON.stringify(packet));

    assert.equal(output.next, "DOCS_MODE_AUTOGEN");
});

test("test_WHAT_IS_DOCS_MODE_choosesTheUpdateArmForUpdateMode", () => {
    const packet = { worktree: "/repo/worktrees/task-9", taskNumber: 9, projectRoot: "/repo", docsMode: "UPDATE", clarifyRequest: "cover the new export" };

    const output = main(JSON.stringify(packet));

    assert.equal(output.next, "DOCS_MODE_UPDATE");
});

test("test_WHAT_IS_DOCS_MODE_throwsOnAnUnknownDocsMode", () => {
    const packet = { worktree: "/repo/worktrees/task-9", taskNumber: 9, projectRoot: "/repo", docsMode: "BOGUS", clarifyRequest: "" };

    assert.throws(() => main(JSON.stringify(packet)));
});
