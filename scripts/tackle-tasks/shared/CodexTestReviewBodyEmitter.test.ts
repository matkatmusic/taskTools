// reviewTestsPrompt still lives in scripts/tackle-tasks/CodexTestReviewBodyEmitter.ts (see its header comment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewTestsPrompt } from "./CodexTestReviewBodyEmitter.ts";
import type { PreparedTask } from "./preparedTask.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "codex-test-review-body-run-log.json");

const SOURCE_BRANCH = "main";

// A real branched repo plus a recorded task-test run, because the emitter derives a diff and reads that run.
function makeTaskFixture(): PreparedTask {
    const projectRoot = mkdtempSync(join(tmpdir(), "review-tests-"));
    const worktree = join(projectRoot, "worktree");
    const rootGit = (...args: string[]) => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    rootGit("init", "--quiet", `--initial-branch=${SOURCE_BRANCH}`);
    rootGit("commit", "--quiet", "--allow-empty", "-m", "base");
    const git = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    for (const dir of ["plans", "src", "tests"]) mkdirSync(join(worktree, dir), { recursive: true });
    git("init", "--quiet", `--initial-branch=${SOURCE_BRANCH}`);
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(worktree, "src", "thing.ts"), "export const thing = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    git("branch", "staging");
    git("checkout", "--quiet", "-b", "task-99");
    writeFileSync(join(worktree, "src", "thing.ts"), "export const thing = 2;\n");
    writeFileSync(join(worktree, "tests", "thing.test.ts"), "// SENTINEL_TASK_TEST\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "task work");
    writeFileSync(join(worktree, "plans", "brief-99.md"), "# brief\n");
    writeFileSync(join(worktree, "plans", "plan.json"), "{}\n");

    const run = {
        runId: "r1", startedAt: "2026-08-18T00:00:00", endedAt: null, exitType: null, exitNote: null,
        modifiedFiles: [], commits: [], implementationNotesFile: null, fullSuite: null,
        taskTests: {
            stepId: "run task tests", testFiles: ["tests/thing.test.ts", "tests/older.test.ts"],
            createdTestFiles: ["tests/thing.test.ts"], deletedTestFiles: [], missingTests: false,
            passed: true, output: "SENTINEL_TASK_TEST_OUTPUT", checkedAt: "2026-08-18T00:00:00",
        },
    };
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{
        taskNumber: 99, files: ["src/thing.ts"],
        run: { active: true, worktree, leaseRunId: "r1", history: [run] },
    }]));

    return {
        number: 99,
        briefFile: join(worktree, "plans", "brief-99.md"),
        planFile: join(worktree, "plans", "plan.json"),
        reviewFile: join(worktree, "plans", "codex-review.json"),
        reviewOutputFile: join(worktree, "plans", "codex-review.json"),
        testReviewFile: join(worktree, "plans", "test-review.json"),
        notesFile: join(worktree, "plans", "implementation-notes-99.md"),
        files: ["src/thing.ts"],
        ownedFilePaths: [join(worktree, "src", "thing.ts")],
        testFilePaths: [join(worktree, "tests", "thing.test.ts")],
        hasTests: true,
        tests: "node --test tests/thing.test.ts",
        codexReviewNotes: "",
        repoRoot: worktree,
        taskStateRoot: projectRoot,
    };
}

const fakeTask = makeTaskFixture();

const templatePath = (name: string) => fileURLToPath(new URL(`../../../plans/${name}`, import.meta.url));

test("test_reviewTestsErrorTemplateKeysMatchTheSchemaRequiredFields", () => {
    // The error shape is spliced into the prompt verbatim, so it cannot drift from what codex is bound by.
    const schema = JSON.parse(readFileSync(templatePath("review-tests-schema.json"), "utf8"));
    const errorTemplate = JSON.parse(readFileSync(templatePath("review-tests-error-template.json"), "utf8"));
    assert.deepEqual(Object.keys(errorTemplate).sort(), [...schema.required].sort());
});

test("test_reviewTestsQuestion_inlinesTheErrorTemplateVerbatim", () => {
    const errorTemplate = readFileSync(templatePath("review-tests-error-template.json"), "utf8").trim();
    assert.ok(reviewTestsPrompt(fakeTask).includes(errorTemplate));
});

test("test_reviewTestsPrompt_namesTheBriefPlanAndTestFilesForTheReviewer", () => {
    // Codex cannot invoke the read-file skill, so every path it must open is listed in the question.
    const task: PreparedTask = { ...fakeTask, testFilePaths: ["/tmp/SENTINEL_TESTFILE_RT_a3/thing.test.ts"] };
    const prompt = reviewTestsPrompt(task);
    for (const path of [task.briefFile, task.planFile, task.testFilePaths[0]]) {
        assert.ok(prompt.includes(path), `prompt is missing ${path}`);
    }
    assert.equal(prompt.includes("---- DATA ----"), false);
});

test("test_reviewTestsPrompt_everyCliLineRedirectsStdinAndCodexIsSchemaBound", () => {
    // codex exec reads stdin even with a prompt argument, and hangs forever in a subagent without this.
    const cliLines = reviewTestsPrompt(fakeTask).replace(/\\\n(?!\s*\|\|)\s*/g, "").split("\n").filter((line) => /^(perl .*codex exec|\s*\|\| claude -p)/.test(line));
    assert.equal(cliLines.length, 3);
    for (const line of cliLines) assert.match(line, /<\/dev\/null/);
    assert.match(cliLines[0], /--output-schema \S*review-tests-schema\.json/);
    assert.match(cliLines[0], /-o "\$REVIEW_FILE"/);
});

test("test_reviewTestsPrompt_capsCodexExecWithAPerlAlarm", () => {
    // codex hangs on a broken models cache; the alarm kills it so the claude -p lines after || get their turn.
    const codexLine = reviewTestsPrompt(fakeTask).replace(/\\\n(?!\s*\|\|)\s*/g, "").split("\n").find((line) => line.includes("codex exec"));
    assert.match(codexLine ?? "", /^perl -e 'alarm shift; exec @ARGV' 300 codex exec /);
});

test("test_reviewTestsPrompt_forbidsRunningTheTests", () => {
    assert.match(reviewTestsPrompt(fakeTask), /Never run a test, and never run the full suite\./);
});

test("test_reviewTestsPrompt_carriesOneQuestionOnly", () => {
    // Earlier prompts emitted the same question body once per CLI; the heredoc must hold exactly one copy.
    const prompt = reviewTestsPrompt(fakeTask);
    assert.equal(prompt.split("## STRICT INPUT ALLOWLIST").length, 2);
});

test("test_reviewTestsPrompt_writesTheImplementationDiffAndNamesItForTheReviewer", () => {
    // Codex is read-only and cannot run git, so the diff it judges against is written out for it.
    const task = makeTaskFixture();
    const prompt = reviewTestsPrompt(task);
    const diffPath = `${task.repoRoot}/plans/implementation-diff-99.patch`;
    assert.ok(prompt.includes(diffPath), "prompt is missing the diff path");
    assert.match(readFileSync(diffPath, "utf8"), /-export const thing = 1;/);
});

test("test_reviewTestsPrompt_separatesTestsThisTaskDidNotCreate", () => {
    const prompt = reviewTestsPrompt(makeTaskFixture());
    assert.match(prompt, /## TESTS THIS TASK DID NOT CREATE\n\n- tests\/older\.test\.ts/);
    assert.equal(prompt.includes("- tests/thing.test.ts\n\nA test in that list"), false);
});

test("test_reviewTestsPrompt_carriesTheTestCommandAndItsRecordedOutput", () => {
    const prompt = reviewTestsPrompt(makeTaskFixture());
    assert.match(prompt, /ran as `node --test tests\/thing\.test\.ts`/);
    assert.match(prompt, /SENTINEL_TASK_TEST_OUTPUT/);
});

test("test_reviewTestsPrompt_throwsWhenNoTaskTestRunIsRecorded", () => {
    // Running this box before the task tests is a caller error, not a review with no evidence.
    const task = makeTaskFixture();
    writeFileSync(join(task.taskStateRoot, "tasks.json"), JSON.stringify([{ taskNumber: 99, files: [], run: { active: true, worktree: null, leaseRunId: null, history: [{ runId: "r1", taskTests: null }] } }]));
    assert.throws(() => reviewTestsPrompt(task), /no recorded task-test run/);
});

test("test_reviewTestsPrompt_tellsTheAgentToReturnTheReviewFilePathEvenWhenTheCommandFails", () => {
    // The spawning agent returns the file path only; ARE_TESTS_FLAGGED reads it and rules on it.
    const task = makeTaskFixture();
    const prompt = reviewTestsPrompt(task);
    assert.match(prompt, new RegExp(`"additionalData": \\{ "reviewFile": "${task.testReviewFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" \\}`));
    assert.match(prompt, /write that same shape anyway/);
});
