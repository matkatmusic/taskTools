// Behavioral checks for scripts/steps/pipeline-reviewPlan/VERDICT_AMEND_THEN_ACCEPT.ts. Mutating: runs only against a temp copy of the fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/VERDICT_AMEND_THEN_ACCEPT.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(import.meta.dirname, "../../../scripts/steps/pipeline-reviewPlan/VERDICT_AMEND_THEN_ACCEPT.template.json");

const FIXTURE_PLAN = {
    task: 42,
    revision: 1,
    createsFiles: [],
    sections: [
        { id: "step-1", title: "Step 1", body: "Edit src/owned.ts to add the export.", codexNotes: "" },
    ],
};

function makeFixture(): { taskStateRoot: string; planFile: string } {
    const taskStateRoot = mkdtempSync(join(tmpdir(), "verdict-amend-then-accept-"));
    const planFile = join(taskStateRoot, "plan.json");
    writeFileSync(planFile, JSON.stringify(FIXTURE_PLAN));
    return { taskStateRoot, planFile };
}

function packet(taskStateRoot: string, planFile: string, fixes: unknown[]) {
    return {
        taskNumber: 42, taskStateRoot, repoRoot: taskStateRoot, planFile,
        runId: "run-1", sourceBranch: "main", plan: FIXTURE_PLAN,
        review: { outcome: "OK", missingFiles: [], message: "", issues: [], fixes, sectionsThatHoldUp: [] },
    };
}

test("test_main_writesTheFixIntoItsSectionAndBumpsTheRevision", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const fix = { sectionId: "step-1", fix: "add the export", durableBecause: "matches source" };

    const output = main(JSON.stringify(packet(taskStateRoot, planFile, [fix])));

    assert.equal(output.box, "VERDICT_AMEND_THEN_ACCEPT");
    assert.equal(output.scriptSignal, "continue");
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    assert.match(plan.sections[0].codexNotes, /add the export/);
    assert.match(plan.sections[0].codexNotes, /matches source/);
    assert.equal(plan.revision, 2);
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_main_throwsWhenAFixNamesASectionThePlanDoesNotHave", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const fix = { sectionId: "no-such-step", fix: "x", durableBecause: "y" };

    assert.throws(() => main(JSON.stringify(packet(taskStateRoot, planFile, [fix]))), /no-such-step/);
});

test("test_main_forwardsTaskIdentityTowardImplement", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(taskStateRoot, planFile, [])));
    assert.equal(output.taskNumber, 42);
    assert.equal(output.taskStateRoot, taskStateRoot);
    assert.equal(output.planFile, planFile);
});

test("test_main_carriesRunIdSourceBranchAndPlanForward", () => {
    const { taskStateRoot, planFile } = makeFixture();
    const output = main(JSON.stringify(packet(taskStateRoot, planFile, [])));
    assert.equal(output.runId, "run-1");
    assert.equal(output.sourceBranch, "main");
    assert.deepEqual(output.plan, FIXTURE_PLAN);
});
