// Behavioral checks for scripts/tackle-tasks/CodexReviewBodyEmitter.ts. Run: node --test tests/CodexReviewBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planReviewPrompt } from "../scripts/tackle-tasks/CodexReviewBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";

const task: PreparedTask = {
    number: 99, briefFile: "/wt/plans/brief-99.md", planFile: "/wt/plans/plan.json",
    reviewFile: "/wt/plans/codex-review.json", reviewOutputFile: "/wt/plans/codex-review.json",
    testReviewFile: "/wt/plans/test-review.json", notesFile: "/wt/plans/implementation-notes-99.md",
    files: ["src/thing.ts"], ownedFilePaths: ["/wt/src/thing.ts"], testFilePaths: [],
    tests: null, codexReviewNotes: "", repoRoot: "/wt", taskStateRoot: "/project",
};

test("test_planReviewPrompt_closesStdinOnEveryReviewerCommand", () => {
    // codex exec reads stdin even with a prompt argument, and hangs forever in a subagent without this.
    const prompt = planReviewPrompt(task);
    for (const line of prompt.split("\n").filter((l) => /^(codex exec|\s*\|\| claude -p)/.test(l))) {
        assert.match(line, /<\/dev\/null/, `reviewer command does not close stdin: ${line}`);
    }
});

test("test_planReviewPrompt_namesTheBriefPlanAndOwnedPathsForTheReviewer", () => {
    const prompt = planReviewPrompt(task);
    for (const path of [task.briefFile, task.planFile, ...task.ownedFilePaths]) {
        assert.ok(prompt.includes(path), `prompt is missing ${path}`);
    }
});

test("test_planReviewPrompt_asksExactlyOneQuestionOnce", () => {
    // One question, one copy: a spliced body that renders twice doubles the reviewer's cost.
    const prompt = planReviewPrompt(task);
    assert.equal(prompt.split("You are a read-only review agent").length, 2);
});

test("test_planReviewPrompt_leavesTheVerdictToTheRulingScript", () => {
    // review-plan has recordPlanReview.ts, so the spawning agent never derives the verdict in prose.
    const prompt = planReviewPrompt(task);
    assert.match(prompt, /recordPlanReview\.ts/);
});

test("test_planReviewPrompt_leavesNoUnresolvedInterpolation", () => {
    assert.equal(planReviewPrompt(task).includes("${"), false);
});

test("test_planReviewPrompt_excludesAnOwnedPathThePlanDeclaresItWillCreate", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "codex-review-createsfiles-"));
    mkdirSync(join(repoRoot, "plans"));
    const planFile = join(repoRoot, "plans", "plan.json");
    writeFileSync(planFile, JSON.stringify({
        task: 99,
        revision: 1,
        createsFiles: ["src/thing.ts"],
        sections: [{ id: "step-1", title: "Step", body: "b" }],
    }));
    const createsTask: PreparedTask = {
        ...task,
        planFile,
        repoRoot,
        ownedFilePaths: [join(repoRoot, "src/thing.ts")],
    };
    const prompt = planReviewPrompt(createsTask);
    assert.equal(prompt.includes(join(repoRoot, "src/thing.ts")), false);
});
