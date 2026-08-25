// Behavioral checks for scripts/steps/pipeline-reviewTests/EXIT_WORKFLOW_REVIEW_TESTS.ts. Run: node --test tests/steps/pipeline-reviewTests/EXIT_WORKFLOW_REVIEW_TESTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewTests/EXIT_WORKFLOW_REVIEW_TESTS.ts";

test("test_main_carriesTheExitTypeAndNoteFromARE_2_TEST_REVIEWS_DONE", () => {
    const input = {
        box: "ARE_2_TEST_REVIEWS_DONE", scriptSignal: "continue", next: "EXIT_WORKFLOW_REVIEW_TESTS",
        projectRoot: "/abs/project", taskNumber: 99, worktreePath: "/abs/project/worktree", sourceBranch: "main",
        runId: "run-1", notes: "", exitType: "tests-flagged", exitNote: "task tests failed codex review",
    };
    const output = main(JSON.stringify(input));
    assert.equal(output.box, "EXIT_WORKFLOW_REVIEW_TESTS");
    assert.equal(output.exitType, "tests-flagged");
    assert.equal(output.exitNote, "task tests failed codex review");
    assert.equal(output.taskNumber, 99);
});

test("test_main_alsoForwardsAnAgentFailedExit", () => {
    // The workflow loop's own synthesized packet has no "next" and empty identity fields; this box must still work.
    const input = {
        box: "", scriptSignal: "continue",
        projectRoot: "", taskNumber: 0, worktreePath: "", sourceBranch: "",
        notes: "", exitType: "agent-failed", exitNote: "the agent returned nothing usable",
    };
    const output = main(JSON.stringify(input));
    assert.equal(output.exitType, "agent-failed");
    assert.equal(output.exitNote, "the agent returned nothing usable");
});
