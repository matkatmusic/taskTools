// Behavioral checks for scripts/steps/pipeline-reviewPlan/WHAT_IS_REVIEW_VERDICT.ts. Ported from tests/recordPlanReview.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/WHAT_IS_REVIEW_VERDICT.ts";

// A three-section plan, so the ruling comes from the fix count rather than the efficacy percentage.
function makeFixture(): { taskStateRoot: string; planFile: string } {
    const taskStateRoot = mkdtempSync(join(tmpdir(), "what-is-review-verdict-"));
    const planFile = join(taskStateRoot, "plan.json");
    writeFileSync(planFile, JSON.stringify({
        task: 7,
        revision: 1,
        sections: [
            { id: "step-1", title: "one", body: "b" },
            { id: "step-2", title: "two", body: "b" },
            { id: "step-3", title: "three", body: "b" },
        ],
    }));
    return { taskStateRoot, planFile };
}

const fix = (sectionId: string) => ({ sectionId, fix: `repair ${sectionId}`, durableBecause: "reason" });
const review = (fixes: ReturnType<typeof fix>[]) => ({
    outcome: "OK" as const, missingFiles: [], message: "", issues: [], fixes, sectionsThatHoldUp: [],
});

function packet(taskStateRoot: string, planFile: string, review: unknown) {
    return {
        taskNumber: 7, taskStateRoot, repoRoot: taskStateRoot, planFile, review,
        runId: "run-1", sourceBranch: "main", plan: { task: 7, revision: 1, createsFiles: [], sections: [] },
    };
}

test("test_main_acceptsAPlanWithNoFixes", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(taskStateRoot, planFile, review([]))));
    assert.equal(output.verdict, "ACCEPT");
    assert.equal(output.next, "VERDICT_ACCEPT");
});

test("test_main_carriesRunIdSourceBranchAndPlanForward", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const p = packet(taskStateRoot, planFile, review([]));
    const output = main(JSON.stringify(p));
    assert.equal(output.runId, p.runId);
    assert.equal(output.sourceBranch, p.sourceBranch);
    assert.deepEqual(output.plan, p.plan);
});

test("test_main_amendsThenAcceptsOnASingleFix", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(taskStateRoot, planFile, review([fix("step-2")]))));
    assert.equal(output.verdict, "AMEND_THEN_ACCEPT");
    assert.equal(output.next, "VERDICT_AMEND_THEN_ACCEPT");
    assert.match(output.notes as string, /repair step-2/);
});

test("test_main_amendsOnTwoFixes", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(taskStateRoot, planFile, review([fix("step-1"), fix("step-2")]))));
    assert.equal(output.verdict, "AMEND");
    assert.equal(output.next, "VERDICT_AMEND");
    assert.match(output.notes as string, /repair step-1/);
    assert.match(output.notes as string, /repair step-2/);
});

test("test_main_scrapsAPlanWithManyFixes", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const fixes = ["step-1", "step-2", "step-3", "step-1", "step-2"].map(fix);
    const output = main(JSON.stringify(packet(taskStateRoot, planFile, review(fixes))));
    assert.equal(output.verdict, "SCRAP");
    assert.equal(output.next, "VERDICT_SCRAP");
});

test("test_main_reportsErrorAsTheVerdictWhenTheReviewerCouldNotReadItsInputs", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const errorReview = {
        outcome: "ERROR" as const,
        missingFiles: ["/gone/plan.json"],
        message: "Review not performed because one or more required input files were unavailable.",
        issues: [], fixes: [], sectionsThatHoldUp: [],
    };
    const output = main(JSON.stringify(packet(taskStateRoot, planFile, errorReview)));
    assert.equal(output.verdict, "ERROR");
    assert.equal(output.next, "VERDICT_ERROR");
    assert.match(output.notes as string, /\/gone\/plan\.json/);
});

test("test_main_readsNoPlanFileWhenOutcomeIsError", () => {
    // The reviewer never saw the plan, so this must not read a plan file that may not exist.
    const output = main(JSON.stringify(packet("/nowhere", "/nowhere/plan.json", {
        outcome: "ERROR", missingFiles: ["x"], message: "m", issues: [], fixes: [], sectionsThatHoldUp: [],
    })));
    assert.equal(output.verdict, "ERROR");
});
