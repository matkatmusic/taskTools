// Behavioral checks for scripts/tackle-tasks/CodexReviewBodyEmitter.ts. Run: node --test tests/CodexReviewBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planReviewPrompt, reviewQuestion } from "./CodexReviewBodyEmitter.ts";
import { writeCheckpoint } from "./checkpoint.ts";
import type { PreparedTask } from "./preparedTask.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "codex-review-body-run-log.json");

const task: PreparedTask = {
    number: 99, briefFile: "/wt/plans/brief-99.md", planFile: "/wt/plans/plan.json",
    reviewFile: "/wt/plans/codex-review.json", reviewOutputFile: "/wt/plans/codex-review.json",
    testReviewFile: "/wt/plans/test-review.json", notesFile: "/wt/plans/implementation-notes-99.md",
    files: ["src/thing.ts"], readOnlyFiles: ["*"], ownedFilePaths: ["/wt/src/thing.ts"], testFilePaths: [],
    hasTests: false, tests: null, codexReviewNotes: "", repoRoot: "/wt", taskStateRoot: "/project",
};

test("test_planReviewPrompt_closesStdinOnEveryReviewerCommand", () => {
    // codex exec reads stdin even with a prompt argument, and hangs forever in a subagent without this.
    const prompt = planReviewPrompt(task).replace(/\\\n\s*/g, "");
    for (const line of prompt.split("\n").filter((l) => /^(perl .*codex exec|\s*\|\| claude -p)/.test(l))) {
        assert.match(line, /<\/dev\/null/, `reviewer command does not close stdin: ${line}`);
    }
});

test("test_planReviewPrompt_capsCodexExecWithAPerlAlarm", () => {
    // codex hangs on a broken models cache; the alarm lets the claude -p fallbacks run instead.
    const codexLine = planReviewPrompt(task).replace(/\\\n\s*/g, "").split("\n").find((line) => line.includes("codex exec"));
    assert.match(codexLine ?? "", /^perl -e 'alarm shift; exec @ARGV' 300 codex exec /);
});

test("test_planReviewPrompt_namesTheBriefPlanAndOwnedPathsForTheReviewer", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "codex-review-owned-"));
    mkdirSync(join(repoRoot, "src"));
    writeFileSync(join(repoRoot, "src/thing.ts"), "");
    const onDiskTask: PreparedTask = { ...task, repoRoot, ownedFilePaths: [join(repoRoot, "src/thing.ts")] };
    const prompt = planReviewPrompt(onDiskTask);
    for (const path of [onDiskTask.briefFile, onDiskTask.planFile, ...onDiskTask.ownedFilePaths]) {
        assert.ok(prompt.includes(path), `prompt is missing ${path}`);
    }
});

test("test_planReviewPrompt_excludesAnOwnedPathMissingFromDiskEvenWhenCreatesFilesIsEmpty", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "codex-review-missing-"));
    const missing = join(repoRoot, ".taskTools/settings.json");
    const prompt = planReviewPrompt({ ...task, repoRoot, ownedFilePaths: [missing] });
    assert.equal(prompt.includes(missing), false);
});

test("test_planReviewPrompt_asksExactlyOneQuestionOnce", () => {
    // One question, one copy: a spliced body that renders twice doubles the reviewer's cost.
    const prompt = planReviewPrompt(task);
    assert.equal(prompt.split("Print the JSON as your final message").length, 2);
});

// WHAT_IS_REVIEW_VERDICT rules on the review file now, so the command no longer runs recordPlanReview.ts.
// test("test_planReviewPrompt_leavesTheVerdictToTheRulingScript", () => {
//     // review-plan has recordPlanReview.ts, so the spawning agent never derives the verdict in prose.
//     const prompt = planReviewPrompt(task);
//     assert.match(prompt, /recordPlanReview\.ts/);
// });

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

test("test_reviewByDefaultPrompt_usesAdversarialLanguageWhenTheDifficultyIsAtLeast7", () => {
    const taskStateRoot = mkdtempSync(join(tmpdir(), "codex-review-difficulty-"));
    mkdirSync(join(taskStateRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(taskStateRoot, ".taskTools/tasks.json"), JSON.stringify([{ taskNumber: 99, difficulty: 7 }]));
    const codexDraftedTask: PreparedTask = { ...task, taskStateRoot };

    const prompt = planReviewPrompt(codexDraftedTask);

    assert.match(prompt, /second, independent codex instance auditing/);
    assert.match(prompt, /do not extend it the benefit of the doubt/);
    assert.match(prompt, /A REJECTION IS YOUR FAILURE/);
});

test("test_reviewByDefaultPrompt_keepsTheOrdinaryWordingBelowDifficulty7", () => {
    const taskStateRoot = mkdtempSync(join(tmpdir(), "codex-review-difficulty-"));
    mkdirSync(join(taskStateRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(taskStateRoot, ".taskTools/tasks.json"), JSON.stringify([{ taskNumber: 99, difficulty: 6 }]));
    const humanDraftedTask: PreparedTask = { ...task, taskStateRoot };

    const prompt = planReviewPrompt(humanDraftedTask);

    assert.match(prompt, /read-only review agent/);
    assert.equal(prompt.includes("second, independent codex instance"), false);
});

test("test_reviewQuestion_approvesOnTheRelaunchAfterAScrap", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "codex-review-resumed-"));
    const resumedTask: PreparedTask = { ...task, repoRoot };
    assert.match(reviewQuestion(resumedTask), /read-only review agent/);
    writeCheckpoint(repoRoot, {
        taskNumber: 42, passId: "p", runId: "run-1", projectRoot: repoRoot,
        block: "pipeline-codexReviewsPlan.mmd::CODEX_REVIEWS_PLAN", input: "", state: "running",
        sourceLockHeld: false, exitType: "", exitNote: "",
        resumedFrom: { block: "pipeline-whatIsReviewVerdict.mmd::TWO_CODEX_REVIEWS_COMPLETED_Q", exitType: "plan-scrapped", exitNote: "n" },
    });
    assert.match(reviewQuestion(resumedTask), /^Approve the plan\./);
});
