// Behavioral checks for scripts/steps/pipeline-reviewPlan/VERDICT_ERROR.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/VERDICT_ERROR.ts";

test("test_main_exitsRunFailedWithTheReviewersNotes", () => {
    const output = main(JSON.stringify({ taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", notes: "message missing: brief.md" }));
    assert.equal(output.box, "VERDICT_ERROR");
    assert.equal(output.exitType, "run-failed");
    assert.equal(output.exitNote, "message missing: brief.md");
});

test("test_main_fallsBackToAFixedNoteWhenNotesIsEmpty", () => {
    const output = main(JSON.stringify({ taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", notes: "" }));
    assert.equal(output.exitNote, "the plan review could not run");
});
