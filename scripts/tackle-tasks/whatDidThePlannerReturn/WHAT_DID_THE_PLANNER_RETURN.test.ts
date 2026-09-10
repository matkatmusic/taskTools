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

function makeProjectRootWithDeclaredTests(difficulty: number, planContents: string): { root: string; planFile: string } {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-tests-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, title: "t", difficulty, schemaVersion: "1.0.1", hasTests: true, modifiableFiles: ["src/thing.ts"],
    }]));
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, planContents);
    return { root, planFile };
}

function base(projectRoot: string) {
    return {
        taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", branch: "task-35",
        projectRoot, docsMode: "", planFile: "", exitType: "", exitNote: "", message: "",
    };
}

test("test_WHAT_DID_THE_PLANNER_RETURN_routesPlanOutcomeToCodexReviewsPlan", () => {
    const output = main(JSON.stringify({ ...base(makeProjectRootWithDifficulty(5)), additionalData: { outcome: "PLAN", planFile: "plans/plan-35.json", clarifyRequest: "" } }));
    assert.equal(output.next, "pipeline-codexReviewsPlan.mmd::IS_PLAN_APPROVED_BY_DEFAULT_Q");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.planFile, "plans/plan-35.json");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_routesPlanOutcomeToImplementTaskWhenDifficultyIsAtMost3", () => {
    // Difficulty 3 skips codex plan review; planner returns PLAN, routes straight to IMPLEMENT_TASK.
    const output = main(JSON.stringify({ ...base(makeProjectRootWithDifficulty(3)), additionalData: { outcome: "PLAN", planFile: "plans/plan-35.json", clarifyRequest: "" } }));
    assert.equal(output.next, "pipeline-implementTask.mmd::IMPLEMENT_TASK");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_amendsWhenThePlanNamesNoDeclaredTestFile", () => {
    const { root, planFile } = makeProjectRootWithDeclaredTests(5, "no test files mentioned here");
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } }));
    assert.equal(output.next, "pipeline-whatIsReviewVerdict.mmd::UPDATE_TASKS_JSON");
    assert.equal(output.verdict, "AMEND");
    assert.equal(output.notes, "the task declares tests but the plan does not name: tests/thing.test.ts");
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

// Only .ts/.tsx is stripped: index.html pairs with tests/index.html.test.ts, so tests/index.test.ts is rejected.
test("test_WHAT_DID_THE_PLANNER_RETURN_requiresTheFullFileNameForANonTypeScriptOwnedFile", () => {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-html-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, title: "t", difficulty: 5, schemaVersion: "1.0.1", hasTests: true, modifiableFiles: ["index.html"],
    }]));
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, "write tests/index.test.ts");
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } }));
    assert.equal(output.verdict, "AMEND");
    assert.equal(output.notes, "the task declares tests but the plan does not name: tests/index.html.test.ts");
});
