// Behavioral checks for scripts/tackle-tasks/recordPlanReview.ts. Run: node --test tests/recordPlanReview.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPlanReview, type PlanReviewFix } from "./recordPlanReview.ts";

// A three-section plan, so the ruling comes from the fix count rather than the efficacy percentage.
function makeFixture(): { projectRoot: string; planFilePath: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "record-plan-review-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{ taskNumber: 7, files: [] }]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    const planFilePath = join(projectRoot, "plan.json");
    writeFileSync(planFilePath, JSON.stringify({
        task: 7,
        revision: 1,
        sections: [
            { id: "step-1", title: "one", body: "b", codexNotes: "" },
            { id: "step-2", title: "two", body: "b", codexNotes: "" },
            { id: "step-3", title: "three", body: "b", codexNotes: "" },
        ],
    }));
    return { projectRoot, planFilePath };
}

const fix = (sectionId: string): PlanReviewFix => ({ sectionId, fix: `repair ${sectionId}`, durableBecause: "reason" });
const review = (fixes: PlanReviewFix[]) => ({
    outcome: "OK" as const, missingFiles: [], message: "", issues: [], fixes, sectionsThatHoldUp: [],
});

test("test_recordPlanReview_acceptsAPlanWithNoFixesAndWritesNothing", () => {
    const { projectRoot, planFilePath } = makeFixture();
    const before = readFileSync(planFilePath, "utf8");

    const output = recordPlanReview({ projectRoot, planFilePath, taskNumber: 7, review: review([]) });

    assert.equal(output.verdict, "ACCEPT");
    assert.equal(readFileSync(planFilePath, "utf8"), before);
});

test("test_recordPlanReview_putsASingleFixOnItsOwnSectionAndSkipsTheSecondReview", () => {
    // One fix is ruling 1, which goes straight to implement, so the implementer must find it in the plan.
    const { projectRoot, planFilePath } = makeFixture();

    const output = recordPlanReview({ projectRoot, planFilePath, taskNumber: 7, review: review([fix("step-2")]) });

    assert.equal(output.verdict, "AMEND_THEN_ACCEPT");
    const plan = JSON.parse(readFileSync(planFilePath, "utf8"));
    assert.match(plan.sections[1].codexNotes, /repair step-2/);
    assert.equal(plan.sections[0].codexNotes, "");
    assert.equal(plan.revision, 2);
});

test("test_recordPlanReview_sendsAReplansNotesToTheTaskEntryTheePlannerReads", () => {
    // Two fixes is ruling 2: the planner replans, and planPrompt renders codexReviewNotes.
    const { projectRoot, planFilePath } = makeFixture();
    const planBefore = readFileSync(planFilePath, "utf8");

    const output = recordPlanReview({
        projectRoot, planFilePath, taskNumber: 7, review: review([fix("step-1"), fix("step-2")]),
    });

    assert.equal(output.verdict, "AMEND");
    const tasks = JSON.parse(readFileSync(join(projectRoot, "tasks.json"), "utf8"));
    assert.match(tasks[0].codexReviewNotes, /repair step-1/);
    assert.match(tasks[0].codexReviewNotes, /repair step-2/);
    assert.equal(readFileSync(planFilePath, "utf8"), planBefore);
});

test("test_recordPlanReview_scrapsAPlanWithManyFixes", () => {
    const { projectRoot, planFilePath } = makeFixture();
    const fixes = ["step-1", "step-2", "step-3", "step-1", "step-2"].map(fix);

    const output = recordPlanReview({ projectRoot, planFilePath, taskNumber: 7, review: review(fixes) });

    assert.equal(output.verdict, "SCRAP");
});

test("test_recordPlanReview_throwsWhenAFixNamesASectionThePlanDoesNotHave", () => {
    // A silent skip would drop the one fix the implementer was supposed to apply.
    const { projectRoot, planFilePath } = makeFixture();

    assert.throws(
        () => recordPlanReview({ projectRoot, planFilePath, taskNumber: 7, review: review([fix("no-such-step")]) }),
        /no-such-step/,
    );
});

test("test_recordPlanReview_reportsErrorAsTheVerdictWhenTheReviewerCouldNotReadItsInputs", () => {
    // The reviewer never read the plan, so no ruling is possible; the run fails on the verdict instead.
    const { projectRoot, planFilePath } = makeFixture();
    const errorReview = {
        outcome: "ERROR" as const,
        missingFiles: ["/gone/plan.json"],
        message: "Review not performed because one or more required input files were unavailable.",
        issues: [], fixes: [], sectionsThatHoldUp: [],
    };

    const output = recordPlanReview({ projectRoot, planFilePath, taskNumber: 7, review: errorReview });

    // Printed on stdout, so the spawning agent copies a real verdict instead of inventing one.
    assert.equal(output.verdict, "ERROR");
    assert.match(output.notes, /\/gone\/plan\.json/);
});
