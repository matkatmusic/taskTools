import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./WHAT_DID_THE_PLANNER_RETURN.ts";

function makeProjectRootWithDifficulty(difficulty: number): string {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 35, title: "t", difficulty }]));
    return root;
}

function base(projectRoot: string) {
    return {
        taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", branch: "task-35",
        projectRoot, docsMode: "", planFile: "", exitType: "", exitNote: "", message: "",
    };
}

test("test_WHAT_DID_THE_PLANNER_RETURN_routesPlanOutcomeToCodexReviewsPlan", () => {
    const output = main(JSON.stringify({ ...base(makeProjectRootWithDifficulty(5)), additionalData: { outcome: "PLAN", planFile: "plans/plan-35.json", clarifyRequest: "" } }));
    assert.equal(output.next, "pipeline-codexReviewsPlan.mmd::CODEX_REVIEWS_PLAN");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.planFile, "plans/plan-35.json");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_routesPlanOutcomeToImplementTaskWhenDifficultyIsAtMost3", () => {
    // Scenario: a task with difficulty 3 skips the codex plan review.
    // Steps: tasks.json holds difficulty 3; the planner returned PLAN; the next block is IMPLEMENT_TASK.
    const output = main(JSON.stringify({ ...base(makeProjectRootWithDifficulty(3)), additionalData: { outcome: "PLAN", planFile: "plans/plan-35.json", clarifyRequest: "" } }));
    assert.equal(output.next, "pipeline-implementTask.mmd::IMPLEMENT_TASK");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_routesClarifyOutcomeToTheRoundsCheck", () => {
    const output = main(JSON.stringify({ ...base(makeProjectRootWithDifficulty(5)), additionalData: { outcome: "CLARIFY", planFile: "", clarifyRequest: "which database?" } }));
    assert.equal(output.next, "ARE_2_CLARIFY_ROUNDS_DONE_Q");
    assert.equal(output.clarifyRequest, "which database?");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_throwsOnAnUnknownOutcome", () => {
    const root = makeProjectRootWithDifficulty(5);
    assert.throws(() => main(JSON.stringify({ ...base(root), additionalData: { outcome: "ERROR", planFile: "", clarifyRequest: "" } })), /unknown planner outcome/);
    assert.throws(() => main(JSON.stringify({ ...base(root), additionalData: { outcome: "MAYBE", planFile: "", clarifyRequest: "" } })), /unknown planner outcome/);
});
