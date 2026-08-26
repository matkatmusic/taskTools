// Behavioral checks for planArtifacts.ts: plan/review validation and the pure amendment rule.  Run alone: node --test tests/planArtifacts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    applyPlanAmendments,
    readAndValidatePlan,
    readAndValidateReview,
    type Plan,
    type PlanAmendment,
} from "../scripts/tackle-tasks/planArtifacts.ts";

function writeJsonFile(value: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "plan-artifacts-"));
    const filePath = join(dir, "file.json");
    writeFileSync(filePath, JSON.stringify(value));
    return filePath;
}

function samplePlan(): Plan {
    return {
        task: 169,
        revision: 1,
        createsFiles: [],
        sections: [
            { id: "problem", title: "Problem", body: "markdown" },
            { id: "step-1", title: "Add the union", body: "markdown" },
            { id: "step-2", title: "Update the function", body: "markdown" },
        ],
    };
}

test("test_readAndValidatePlan_acceptsAWellFormedPlan", () => {
    // Step: a plan file matching the expected task number and shape.
    const filePath = writeJsonFile(samplePlan());
    const result = readAndValidatePlan(filePath, 169);
    // Step: the result is the plan itself, not a problem.
    assert.deepEqual(result, samplePlan());
});

test("test_readAndValidatePlan_rejectsAMismatchedTaskNumber", () => {
    const filePath = writeJsonFile(samplePlan());
    const result = readAndValidatePlan(filePath, 999);
    assert.ok("problem" in result);
});

test("test_readAndValidatePlan_rejectsANonPositiveRevision", () => {
    const filePath = writeJsonFile({ ...samplePlan(), revision: 0 });
    const result = readAndValidatePlan(filePath, 169);
    assert.ok("problem" in result);
});

test("test_readAndValidatePlan_rejectsAnEmptySectionsArray", () => {
    const filePath = writeJsonFile({ ...samplePlan(), sections: [] });
    const result = readAndValidatePlan(filePath, 169);
    assert.ok("problem" in result);
});

test("test_readAndValidatePlan_rejectsADuplicateSectionId", () => {
    const plan = samplePlan();
    const filePath = writeJsonFile({ ...plan, sections: [...plan.sections, plan.sections[0]] });
    const result = readAndValidatePlan(filePath, 169);
    assert.ok("problem" in result);
});

test("test_readAndValidatePlan_rejectsASectionIdThatIsNotKebabCase", () => {
    const plan = samplePlan();
    plan.sections[0] = { ...plan.sections[0], id: "Not_Kebab" };
    const filePath = writeJsonFile(plan);
    const result = readAndValidatePlan(filePath, 169);
    assert.ok("problem" in result);
});

test("test_readAndValidatePlan_rejectsUnparsableJson", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-artifacts-"));
    const filePath = join(dir, "file.json");
    writeFileSync(filePath, "{not json");
    const result = readAndValidatePlan(filePath, 169);
    assert.ok("problem" in result);
});

test("test_readAndValidateReview_acceptsAWellFormedAmendVerdict", () => {
    const filePath = writeJsonFile({
        verdict: "amend",
        notes: "step-2 is unclear",
        amendments: [{ op: "remove", id: "step-2" }],
    });
    const result = readAndValidateReview(filePath);
    assert.ok(!("problem" in result));
    assert.equal(result.verdict, "amend");
});

test("test_readAndValidateReview_acceptsAWellFormedScrapVerdict", () => {
    const filePath = writeJsonFile({ verdict: "scrap", notes: "start over" });
    const result = readAndValidateReview(filePath);
    assert.ok(!("problem" in result));
    assert.equal(result.verdict, "scrap");
});

test("test_readAndValidateReview_rejectsAnAmendVerdictWithNoAmendments", () => {
    const filePath = writeJsonFile({ verdict: "amend", amendments: [] });
    const result = readAndValidateReview(filePath);
    assert.ok("problem" in result);
});

test("test_readAndValidateReview_rejectsAScrapVerdictWithNoNotes", () => {
    const filePath = writeJsonFile({ verdict: "scrap" });
    const result = readAndValidateReview(filePath);
    assert.ok("problem" in result);
});

test("test_readAndValidateReview_rejectsAnInsertAmendmentWithANonKebabId", () => {
    const filePath = writeJsonFile({
        verdict: "amend",
        amendments: [{ op: "insert", after: "problem", id: "Not_Kebab", title: "T", body: "B" }],
    });
    const result = readAndValidateReview(filePath);
    assert.ok("problem" in result);
});

test("test_readAndValidateReview_rejectsAnUnknownVerdict", () => {
    const filePath = writeJsonFile({ verdict: "reject" });
    const result = readAndValidateReview(filePath);
    assert.ok("problem" in result);
});

test("test_applyPlanAmendments_replaceSwapsTitleAndBodyAndKeepsPosition", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [{ op: "replace", id: "step-1", title: "New title", body: "new body" }];
    const result = applyPlanAmendments(plan, amendments);
    assert.equal(result.status, "applied");
    assert.ok(result.status === "applied");
    assert.deepEqual(result.plan.sections.map((s) => s.id), ["problem", "step-1", "step-2"]);
    assert.deepEqual(result.plan.sections[1], { id: "step-1", title: "New title", body: "new body" });
});

test("test_applyPlanAmendments_insertPlacesTheNewSectionAfterTheNamedSection", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [{ op: "insert", after: "step-1", id: "step-1a", title: "T", body: "B" }];
    const result = applyPlanAmendments(plan, amendments);
    assert.ok(result.status === "applied");
    assert.deepEqual(result.plan.sections.map((s) => s.id), ["problem", "step-1", "step-1a", "step-2"]);
});

test("test_applyPlanAmendments_removeDropsTheNamedSection", () => {
    const plan = samplePlan();
    const result = applyPlanAmendments(plan, [{ op: "remove", id: "step-1" }]);
    assert.ok(result.status === "applied");
    assert.deepEqual(result.plan.sections.map((s) => s.id), ["problem", "step-2"]);
});

test("test_applyPlanAmendments_incrementsRevisionExactlyOncePerBatch", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [
        { op: "remove", id: "step-1" },
        { op: "insert", after: "problem", id: "step-1a", title: "T", body: "B" },
    ];
    const result = applyPlanAmendments(plan, amendments);
    assert.ok(result.status === "applied");
    assert.equal(result.plan.revision, plan.revision + 1);
});

test("test_applyPlanAmendments_rejectsTheWholeBatchWhenAnyIdIsNotInThePlan", () => {
    const plan = samplePlan();
    const result = applyPlanAmendments(plan, [{ op: "remove", id: "does-not-exist" }]);
    assert.equal(result.status, "rejected");
    assert.deepEqual(plan, samplePlan());
});

test("test_applyPlanAmendments_rejectsTheWholeBatchWhenAnInsertReusesAnExistingId", () => {
    const plan = samplePlan();
    const result = applyPlanAmendments(plan, [{ op: "insert", after: "problem", id: "step-1", title: "T", body: "B" }]);
    assert.equal(result.status, "rejected");
});

test("test_applyPlanAmendments_rejectsAnEmptyAmendmentList", () => {
    const plan = samplePlan();
    const result = applyPlanAmendments(plan, []);
    assert.equal(result.status, "rejected");
});

test("test_applyPlanAmendments_rejectsInsertingAfterASectionRemovedEarlierInTheBatch", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [
        { op: "remove", id: "step-2" },
        { op: "insert", after: "step-2", id: "step-2a", title: "T", body: "B" },
    ];
    const result = applyPlanAmendments(plan, amendments);
    assert.equal(result.status, "rejected");
});

test("test_applyPlanAmendments_rejectsReplacingASectionRemovedEarlierInTheBatch", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [
        { op: "remove", id: "step-2" },
        { op: "replace", id: "step-2", body: "new body" },
    ];
    const result = applyPlanAmendments(plan, amendments);
    assert.equal(result.status, "rejected");
});

test("test_applyPlanAmendments_allowsReplacingASectionInsertedEarlierInTheBatch", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [
        { op: "insert", after: "problem", id: "step-0a", title: "T", body: "B" },
        { op: "replace", id: "step-0a", title: "T2", body: "B2" },
    ];
    const result = applyPlanAmendments(plan, amendments);
    assert.ok(result.status === "applied");
    const inserted = result.plan.sections.find((s) => s.id === "step-0a");
    assert.deepEqual(inserted, { id: "step-0a", title: "T2", body: "B2" });
});

test("test_applyPlanAmendments_rejectsANonKebabInsertedId", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [{ op: "insert", after: "problem", id: "Not_Kebab", title: "T", body: "B" }];
    const result = applyPlanAmendments(plan, amendments);
    assert.equal(result.status, "rejected");
    assert.deepEqual(plan, samplePlan());
});

test("test_applyPlanAmendments_rejectsRemovingTheSoleSection", () => {
    const plan: Plan = { task: 169, revision: 1, createsFiles: [], sections: [{ id: "only", title: "Only", body: "b" }] };
    const result = applyPlanAmendments(plan, [{ op: "remove", id: "only" }]);
    assert.equal(result.status, "rejected");
});

test("test_applyPlanAmendments_rejectsRemovingAllSectionsAcrossABatch", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = plan.sections.map((section) => ({ op: "remove", id: section.id }));
    const result = applyPlanAmendments(plan, amendments);
    assert.equal(result.status, "rejected");
    assert.deepEqual(plan, samplePlan());
});

test("test_applyPlanAmendments_appliesAmendmentsInTheOrderGiven", () => {
    const plan = samplePlan();
    const amendments: PlanAmendment[] = [
        { op: "insert", after: "problem", id: "a", title: "A", body: "A" },
        { op: "insert", after: "a", id: "b", title: "B", body: "B" },
    ];
    const result = applyPlanAmendments(plan, amendments);
    assert.ok(result.status === "applied");
    assert.deepEqual(result.plan.sections.map((s) => s.id), ["problem", "a", "b", "step-1", "step-2"]);
});
