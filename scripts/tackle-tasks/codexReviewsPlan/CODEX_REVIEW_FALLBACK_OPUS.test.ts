// Behavioral checks for CODEX_REVIEW_FALLBACK_OPUS.ts: retries the review question with claude opus only, no chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./CODEX_REVIEW_FALLBACK_OPUS.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "codex-review-fallback-opus-run-log.json");

function makeFixture(): { worktree: string; projectRoot: string } {
    const repoRoot = mkdtempSync(join(tmpdir(), "codex-review-fallback-opus-"));
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
        box: "DID_FABLE_REVIEW_SUCCEED_Q", scriptSignal: "continue", taskNumber: 42, runId: "run-1",
        projectRoot: fixture.projectRoot, worktree: fixture.worktree, branch: "main",
        planFile: join(fixture.worktree, "plans/plan.json"), exitType: "", exitNote: "",
    };
}

test("test_main_returnsAPromptSignal", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal(output.box, "CODEX_REVIEW_FALLBACK_OPUS");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_main_asksTheAgentToReviewItselfWithNoCli", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    const prompt = output.prompt as string;
    assert.match(prompt, /## YOU ARE THE FALLBACK REVIEWER/);
    assert.equal(prompt.includes("claude -p"), false);
    assert.equal(prompt.includes("codex exec"), false);
    assert.equal(prompt.includes("||"), false);
});

test("test_main_neverTellsTheAgentToTypeARunStepCommand", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal(/\/run-step/.test(output.prompt as string), false);
});
