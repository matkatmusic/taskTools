// Behavioral checks for scripts/steps/pipeline-reviewPlan/CODEX_REVIEWS_PLAN.ts. Ported from tests/CodexReviewBodyEmitter.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/CODEX_REVIEWS_PLAN.ts";

function makeFixture(): { repoRoot: string; briefFile: string; planFile: string; reviewOutputFile: string; ownedFilePaths: string[] } {
    const repoRoot = mkdtempSync(join(tmpdir(), "codex-reviews-plan-"));
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    const briefFile = join(repoRoot, "plans/brief-42.md");
    const planFile = join(repoRoot, "plans/plan.json");
    const reviewOutputFile = join(repoRoot, "plans/codex-review.json");
    writeFileSync(briefFile, "the brief");
    writeFileSync(planFile, JSON.stringify({ task: 42, revision: 1, createsFiles: [], sections: [{ id: "step-1", title: "one", body: "b" }] }));
    writeFileSync(join(repoRoot, "src/owned.ts"), "export const x = 1;");
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 42, files: ["src/owned.ts"] }]));
    return { repoRoot, briefFile, planFile, reviewOutputFile, ownedFilePaths: [join(repoRoot, "src/owned.ts")] };
}

function packetFrom(fixture: ReturnType<typeof makeFixture>) {
    return { taskNumber: 42, taskStateRoot: fixture.repoRoot, ...fixture };
}

test("test_main_returnsAPromptSignal", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal(output.box, "CODEX_REVIEWS_PLAN");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_main_closesStdinOnEveryReviewerCommand", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.match(output.prompt as string, /codex exec[\s\S]*<\/dev\/null/);
});

test("test_main_namesTheBriefPlanAndOwnedPathsForTheReviewer", () => {
    const fixture = makeFixture();
    main(JSON.stringify(packetFrom(fixture)));
    const promptFileContents = readFileSync(join(fixture.repoRoot, "plans/CODEX_REVIEWS_PLAN.prompt.md"), "utf8");
    assert.match(promptFileContents, new RegExp(fixture.briefFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(promptFileContents, new RegExp(fixture.planFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(promptFileContents, new RegExp(fixture.ownedFilePaths[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("test_main_neverTellsTheAgentToTypeARunStepCommand", () => {
    // An agent() error is the workflow loop's job; this box never routes by typing /run-step itself.
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal(/\/run-step/.test(output.prompt as string), false);
});

test("test_main_tellsTheAgentToReturnThePathEvenWhenTheCommandFails", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.match(output.prompt as string, /"reviewFile"/);
    assert.doesNotMatch(output.prompt as string, /review\.outcome/);
});

test("test_main_leavesNoUnresolvedInterpolation", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal((output.prompt as string).includes("${"), false);
});
