// Behavioral checks for WHAT_IS_REVIEW_VERDICT.ts. Ported from pipeline-reviewPlan's WHAT_IS_REVIEW_VERDICT + VERDICT_* tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./WHAT_IS_REVIEW_VERDICT.ts";

function makeFixture(): { projectRoot: string; planFile: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "what-is-review-verdict-"));
    const planFile = join(projectRoot, "plan.json");
    writeFileSync(planFile, JSON.stringify({
        task: 7,
        revision: 1,
        createsFiles: [],
        sections: [
            { id: "step-1", title: "one", body: "b", codexNotes: "" },
            { id: "step-2", title: "two", body: "b", codexNotes: "" },
            { id: "step-3", title: "three", body: "b", codexNotes: "" },
        ],
    }));
    return { projectRoot, planFile };
}

const fix = (sectionId: string) => ({ sectionId, fix: `repair ${sectionId}`, durableBecause: "reason" });
const review = (fixes: ReturnType<typeof fix>[]) => ({
    outcome: "OK" as const, missingFiles: [], message: "", issues: [], fixes, sectionsThatHoldUp: [],
});

function packet(projectRoot: string, planFile: string, reviewBody: unknown) {
    const reviewOutputFile = join(projectRoot, "codex-review.json");
    writeFileSync(reviewOutputFile, JSON.stringify(reviewBody));
    return {
        box: "CODEX_REVIEWS_PLAN", scriptSignal: "continue",
        taskNumber: 7, runId: "run-1", projectRoot, worktree: projectRoot, branch: "main", docsMode: "",
        planFile, exitType: "", exitNote: "", message: "", additionalData: { reviewFile: reviewOutputFile },
    };
}

test("test_main_acceptsAPlanWithNoFixesAndRoutesToImplement", () => {
    const { projectRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(projectRoot, planFile, review([]))));
    assert.equal(output.verdict, "ACCEPT");
    assert.equal(output.next, "pipeline-implementTask.mmd::IMPLEMENT_TASK");
});

test("test_main_amendsThenAcceptsOnASingleFixAndWritesThePlan", () => {
    const { projectRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(projectRoot, planFile, review([fix("step-2")]))));
    assert.equal(output.verdict, "AMEND_THEN_ACCEPT");
    assert.equal(output.next, "pipeline-implementTask.mmd::IMPLEMENT_TASK");
    assert.match(output.notes as string, /repair step-2/);
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    assert.match(plan.sections[1].codexNotes, /repair step-2/);
    assert.equal(plan.revision, 2);
});

test("test_main_throwsWhenAnAmendThenAcceptFixNamesASectionThePlanDoesNotHave", () => {
    const { projectRoot, planFile } = makeFixture();
    assert.throws(
        () => main(JSON.stringify(packet(projectRoot, planFile, review([fix("no-such-step")])))),
        /no-such-step/,
    );
});

test("test_main_amendsOnTwoFixesAndRoutesToUpdateTasksJson", () => {
    const { projectRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(projectRoot, planFile, review([fix("step-1"), fix("step-2")]))));
    assert.equal(output.verdict, "AMEND");
    assert.equal(output.next, "UPDATE_TASKS_JSON");
    assert.match(output.notes as string, /repair step-1/);
    assert.match(output.notes as string, /repair step-2/);
});

test("test_main_scrapsAPlanWithManyFixesAndRoutesToUpdateTasksJson", () => {
    const { projectRoot, planFile } = makeFixture();
    const fixes = ["step-1", "step-2", "step-3", "step-1", "step-2"].map(fix);
    const output = main(JSON.stringify(packet(projectRoot, planFile, review(fixes))));
    assert.equal(output.verdict, "SCRAP");
    assert.equal(output.next, "UPDATE_TASKS_JSON");
});

test("test_main_reportsErrorAndExitsToFailuresWhenTheReviewerCouldNotReadItsInputs", () => {
    const { projectRoot, planFile } = makeFixture();
    const errorReview = {
        outcome: "ERROR" as const,
        missingFiles: ["/gone/plan.json"],
        message: "Review not performed because one or more required input files were unavailable.",
        issues: [], fixes: [], sectionsThatHoldUp: [],
    };
    const output = main(JSON.stringify(packet(projectRoot, planFile, errorReview)));
    assert.equal(output.verdict, "ERROR");
    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "run-failed");
    assert.match(output.exitNote as string, /\/gone\/plan\.json/);
});

test("test_main_readsNoPlanFileWhenOutcomeIsError", () => {
    // The reviewer never saw the plan, so this must not read a plan file that may not exist.
    const projectRoot = mkdtempSync(join(tmpdir(), "what-is-review-verdict-"));
    const output = main(JSON.stringify(packet(projectRoot, "/nowhere/plan.json", {
        outcome: "ERROR", missingFiles: ["x"], message: "m", issues: [], fixes: [], sectionsThatHoldUp: [],
    })));
    assert.equal(output.verdict, "ERROR");
});

test("test_main_carriesTaskIdentityForward", () => {
    const { projectRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(projectRoot, planFile, review([]))));
    assert.equal(output.taskNumber, 7);
    assert.equal(output.runId, "run-1");
    assert.equal(output.branch, "main");
});
