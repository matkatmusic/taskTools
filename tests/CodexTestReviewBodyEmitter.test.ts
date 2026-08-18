// Behavioral checks for scripts/tackle-tasks/CodexTestReviewBodyEmitter.ts. Run: node --test tests/CodexTestReviewBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reviewTestsPrompt } from "../scripts/tackle-tasks/CodexTestReviewBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";

// A hand-built PreparedTask for structural tests that never touch a real worktree.
const fakeTask: PreparedTask = {
    number: 99,
    briefFile: "/tmp/fake-worktree/plans/brief-99.md",
    planFile: "/tmp/fake-worktree/plans/plan.json",
    reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
    reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
    testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
    notesFile: "/tmp/fake-worktree/plans/implementation-notes-99.md",
    files: ["src/thing.ts"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    testFilePaths: ["/tmp/fake-worktree/tests/thing.test.ts"],
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

const templatePath = (name: string) => fileURLToPath(new URL(`../plans/${name}`, import.meta.url));

test("test_reviewTestsErrorTemplateKeysMatchTheSchemaRequiredFields", () => {
    // The error shape is spliced into the prompt verbatim, so it cannot drift from what codex is bound by.
    const schema = JSON.parse(readFileSync(templatePath("review-tests-schema.json"), "utf8"));
    const errorTemplate = JSON.parse(readFileSync(templatePath("review-tests-error-template.json"), "utf8"));
    assert.deepEqual(Object.keys(errorTemplate).sort(), [...schema.required].sort());
});

test("test_reviewTestsQuestion_inlinesTheErrorTemplateVerbatim", () => {
    // A paraphrased error shape would not validate against the schema codex is given.
    const errorTemplate = readFileSync(templatePath("review-tests-error-template.json"), "utf8").trim();
    assert.ok(reviewTestsPrompt(fakeTask).includes(errorTemplate));
});

test("test_reviewTestsPrompt_namesTheBriefPlanAndTestFilesForTheReviewer", () => {
    // Codex cannot invoke the read-file skill, so every path it must open is listed in the question.
    const task: PreparedTask = {
        ...fakeTask,
        briefFile: "/tmp/SENTINEL_BRIEF_RT_a1/brief.md",
        planFile: "/tmp/SENTINEL_PLANFILE_RT_a2/plan.json",
        testFilePaths: ["/tmp/SENTINEL_TESTFILE_RT_a3/thing.test.ts"],
    };
    const prompt = reviewTestsPrompt(task);
    for (const path of [task.briefFile, task.planFile, task.testFilePaths[0]]) {
        assert.ok(prompt.includes(path), `prompt is missing ${path}`);
    }
    assert.equal(prompt.includes("---- DATA ----"), false);
});

test("test_reviewTestsPrompt_everyCliLineRedirectsStdinAndCodexIsSchemaBound", () => {
    // codex exec reads stdin even with a prompt argument, and hangs forever in a subagent without this.
    const cliLines = reviewTestsPrompt(fakeTask).split("\n").filter((line) => /^(codex exec|\s*\|\| claude -p)/.test(line));
    assert.equal(cliLines.length, 3);
    for (const line of cliLines) assert.match(line, /<\/dev\/null/);
    assert.match(cliLines[0], /--output-schema \S*review-tests-schema\.json/);
    assert.match(cliLines[0], /-o "\$REVIEW_FILE"/);
});

test("test_reviewTestsPrompt_forbidsRunningTheTests", () => {
    // This box judges what the tests assert; running them is the task-tests pipeline's job.
    assert.match(reviewTestsPrompt(fakeTask), /Never run a test, and never run the full suite\./);
});

test("test_reviewTestsPrompt_citesTheOutputTemplateAndCarriesOneQuestionOnly", () => {
    // Earlier prompts emitted the same question body once per CLI; the heredoc must hold exactly one copy.
    const prompt = reviewTestsPrompt(fakeTask);
    assert.match(prompt, /review-tests-output-template\.json/);
    assert.equal(prompt.split("## STRICT INPUT ALLOWLIST").length, 2);
});

test("test_reviewTestsOutputTemplateKeysMatchTheWorkflowReviewTestsResult", () => {
    // The workflow validates the receipt against REVIEW_TESTS_RESULT, so the template cannot drift from it.
    const workflowPath = fileURLToPath(new URL("../scripts/tackle-tasks/tackle-tasks.workflow.template.js", import.meta.url));
    const workflow = readFileSync(workflowPath, "utf8");
    const block = workflow.slice(workflow.indexOf("const REVIEW_TESTS_RESULT"));
    const properties = [...block.slice(0, block.indexOf("}\n")).matchAll(/(\w+): \{ type:/g)].map((match) => match[1]);
    const template = JSON.parse(readFileSync(templatePath("review-tests-output-template.json"), "utf8"));
    assert.deepEqual(Object.keys(template).sort(), properties.sort());
});
