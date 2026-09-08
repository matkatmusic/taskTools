// Behavioral checks for scripts/tackle-tasks/codexReviewsPlan/CODEX_REVIEWS_PLAN.ts. Ported from archive/tackle-tasks-v1_5's pipeline-reviewPlan test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./CODEX_REVIEWS_PLAN.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "codex-reviews-plan-run-log.json");

function makeFixture(): { worktree: string; projectRoot: string } {
    const repoRoot = mkdtempSync(join(tmpdir(), "codex-reviews-plan-"));
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, "plans/brief-42.md"), "the brief");
    writeFileSync(join(repoRoot, "plans/plan.json"), JSON.stringify({ task: 42, revision: 1, createsFiles: [], sections: [{ id: "step-1", title: "one", body: "b" }] }));
    writeFileSync(join(repoRoot, "src/owned.ts"), "export const x = 1;");
    writeFileSync(join(repoRoot, ".taskTools/tasks.json"), JSON.stringify([{ taskNumber: 42, modifiableFiles: ["src/owned.ts"] }]));
    return { worktree: repoRoot, projectRoot: repoRoot };
}

function packetFrom(fixture: ReturnType<typeof makeFixture>) {
    return {
        box: "WHAT_DID_THE_PLANNER_RETURN",
        scriptSignal: "continue",
        taskNumber: 42,
        runId: "run-1",
        projectRoot: fixture.projectRoot,
        worktree: fixture.worktree,
        branch: "main",
        docsMode: "",
        planFile: join(fixture.worktree, "plans/plan.json"),
        exitType: "",
        exitNote: "",
    };
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
    const output = main(JSON.stringify(packetFrom(fixture)));
    const prompt = output.prompt as string;
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(prompt, new RegExp(escape(join(fixture.worktree, "plans/brief-42.md"))));
    assert.match(prompt, new RegExp(escape(join(fixture.worktree, "plans/plan.json"))));
    assert.match(prompt, new RegExp(escape(join(fixture.worktree, "src/owned.ts"))));
});

test("test_main_neverTellsTheAgentToTypeARunStepCommand", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal(/\/run-step/.test(output.prompt as string), false);
});

test("test_main_neverInvokesASkill", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal(/invoke the skill/i.test(output.prompt as string), false);
});

test("test_main_tellsTheAgentToRunTheWriteReviewAnswerScript", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.match(output.prompt as string, /node .*writeReviewAnswer\.ts "<the outcome\.payload path>"/);
});

test("test_main_leavesNoUnresolvedInterpolation", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal((output.prompt as string).includes("${"), false);
});
