import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./WHAT_DID_THE_PLANNER_RETURN.ts";

// The block reads the run's own steps.json to tell the default pipeline from the fast one.
function writeStepsConfig(root: string, diagramFile: string): void {
    mkdirSync(join(root, ".taskTools", "workflows", "35"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "workflows", "35", "steps.json"), JSON.stringify({ [diagramFile]: [] }));
}

function makeProjectRootWithDifficulty(difficulty: number): string {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 35, title: "t", difficulty }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
    return root;
}

function makeProjectRootWithDeclaredTests(difficulty: number, planContents: string): { root: string; planFile: string } {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-tests-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, title: "t", difficulty, schemaVersion: "1.0.1", hasTests: true, modifiableFiles: ["src/thing.ts"],
    }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
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
    assert.equal(output.notes, "the task declares tests but the plan does not name: tests/test-thing.ts or tests/thing.test.ts or src/thing.test.ts");
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

// An owned file whose extension has no test rule (html has no LanguageConfig) needs no named test.
test("test_WHAT_DID_THE_PLANNER_RETURN_skipsAnOwnedFileWithNoTestRule", () => {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-html-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, title: "t", difficulty: 5, schemaVersion: "1.0.1", hasTests: true, modifiableFiles: ["index.html"],
    }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, "no test files mentioned here");
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } }));
    assert.notEqual(output.verdict, "AMEND");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_routesStraightOnWhenTheTaskSkipsTests", () => {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-skip-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, title: "t", difficulty: 3, schemaVersion: "1.0.1", hasTests: true, tests: "skip", modifiableFiles: ["src/thing.ts"],
    }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, "no test files mentioned here");
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } }));
    assert.notEqual(output.verdict, "AMEND");
    assert.equal(output.next, "pipeline-implementTask.mmd::IMPLEMENT_TASK");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_mergesAdditionalFilesIntoModifiableFilesBeforeCheckingForNamedTests", () => {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-additional-files-"));
    const tasksPath = join(root, ".taskTools", "tasks.json");
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(tasksPath, JSON.stringify([{
        taskNumber: 35, title: "t", difficulty: 5, schemaVersion: "1.0.1", hasTests: true, modifiableFiles: ["index.html"],
    }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, "no test files mentioned here");

    const output = main(JSON.stringify({
        ...base(root),
        additionalData: { outcome: "PLAN", planFile, clarifyRequest: "", additionalFiles: ["tests/index.html.test.ts"] },
    }));

    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    assert.deepEqual(tasks[0].modifiableFiles, ["index.html", "tests/index.html.test.ts"]);
    assert.notEqual(output.verdict, "AMEND");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_leavesModifiableFilesUnchangedWhenAdditionalFilesIsEmpty", () => {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-no-additional-files-"));
    const tasksPath = join(root, ".taskTools", "tasks.json");
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(tasksPath, JSON.stringify([{ taskNumber: 35, title: "t", difficulty: 5, modifiableFiles: ["src/thing.ts"] }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, "plan text");

    main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "", additionalFiles: [] } }));

    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    assert.deepEqual(tasks[0].modifiableFiles, ["src/thing.ts"]);
});

test("test_WHAT_DID_THE_PLANNER_RETURN_mergingAdditionalFilesDedupesAgainstAlreadyOwnedFiles", () => {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-dedupe-"));
    const tasksPath = join(root, ".taskTools", "tasks.json");
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(tasksPath, JSON.stringify([{ taskNumber: 35, title: "t", difficulty: 5, modifiableFiles: ["src/thing.ts"] }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, "plan text");

    main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "", additionalFiles: ["src/thing.ts"] } }));

    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    assert.deepEqual(tasks[0].modifiableFiles, ["src/thing.ts"]);
});

test("test_WHAT_DID_THE_PLANNER_RETURN_passesWhenThePlanNamesTheCoLocatedCandidate", () => {
    const root = mkdtempSync(join(tmpdir(), "what-did-the-planner-return-colocated-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, title: "t", difficulty: 5, schemaVersion: "1.0.1", hasTests: true, modifiableFiles: ["scripts/x/y.ts"],
    }]));
    writeStepsConfig(root, "pipeline-codexReviewsPlan.mmd");
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, "write scripts/x/y.test.ts alongside the source file");
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } }));
    assert.notEqual(output.verdict, "AMEND");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_routesPlanOutcomeStraightToImplementTaskOnAFastRun", () => {
    // Setup: a difficulty-5 task whose run walks the fast diagram set.
    const root = makeProjectRootWithDifficulty(5);
    writeStepsConfig(root, "pipeline-implementTask.mmd");

    // Test action: the planner accepts the plan.
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile: "plans/plan-35.json", clarifyRequest: "" } }));

    // Verification: a fast run has no codex plan review, so the plan goes to the implementer.
    assert.equal(output.next, "pipeline-implementTask.mmd::IMPLEMENT_TASK");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_skipsTheDeclaredTestCheckOnAFastRun", () => {
    // Setup: a task that declares tests, and a plan that names none of them.
    const { root, planFile } = makeProjectRootWithDeclaredTests(5, "no test files mentioned here");
    writeStepsConfig(root, "pipeline-implementTask.mmd");

    // Test action: the planner accepts the plan.
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } }));

    // Verification: the fast set has no verdict diagram, so no AMEND hop is named.
    assert.notEqual(output.verdict, "AMEND");
    assert.equal(output.next, "pipeline-implementTask.mmd::IMPLEMENT_TASK");
});

test("test_WHAT_DID_THE_PLANNER_RETURN_routesClarifyOutcomeToTheRoundsCheckOnAFastRun", () => {
    // Step: the fast set keeps the clarify loop, so a CLARIFY answer routes inside the same diagram.
    const root = makeProjectRootWithDifficulty(5);
    writeStepsConfig(root, "pipeline-implementTask.mmd");
    const output = main(JSON.stringify({ ...base(root), additionalData: { outcome: "CLARIFY", planFile: "", clarifyRequest: "which database?" } }));
    assert.equal(output.next, "ARE_2_CLARIFY_ROUNDS_DONE_Q");
});
