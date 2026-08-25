// Behavioral checks for scripts/steps/pipeline-reviewTests/ARE_TESTS_FLAGGED.ts. Run: node --test tests/steps/pipeline-reviewTests/ARE_TESTS_FLAGGED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewTests/ARE_TESTS_FLAGGED.ts";

const core = {
    projectRoot: "/abs/project", taskNumber: 99, worktree: "/abs/project/worktree", sourceBranch: "main",
    planFile: "/abs/project/worktree/plans/plan.json", testFilePaths: ["/abs/project/worktree/tests/thing.test.ts"],
    testCommand: "node --test tests/thing.test.ts", testOutput: "ok",
};

test("test_main_routesToRebasePreambleWhenNotFlagged", () => {
    const output = main(JSON.stringify({ ...core, flagged: false, notes: "" }));
    assert.equal(output.next, "REBASE_PREAMBLE_PIPELINE");
    assert.equal(output.notes, "");
    for (const [key, value] of Object.entries(core)) assert.deepEqual(output[key], value);
});

test("test_main_routesToAre2TestReviewsDoneWhenFlagged", () => {
    const output = main(JSON.stringify({ ...core, flagged: true, notes: "SENTINEL_NOTES" }));
    assert.equal(output.next, "ARE_2_TEST_REVIEWS_DONE");
    assert.equal(output.notes, "SENTINEL_NOTES");
});

test("test_main_dropsTheNotesWhenTheHappyArmIsTaken", () => {
    // A stray note on the passing branch would be a leftover from a prior review, not this one.
    const output = main(JSON.stringify({ ...core, flagged: false, notes: "stale notes" }));
    assert.equal(output.notes, "");
});
