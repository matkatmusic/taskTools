// Behavioral checks for scripts/tackle-tasks/codexReviewsTests/CODEX_REVIEWS_TESTS.ts.  reviewTestsPrompt's own content is covered by shared/CodexTestReviewBodyEmitter.test.ts; this file covers packet wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./CODEX_REVIEWS_TESTS.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "codex-reviews-tests-run-log.json");

const SOURCE_BRANCH = "main";

function makePacket() {
    const projectRoot = mkdtempSync(join(tmpdir(), "codex-reviews-tests-"));
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
    writeFileSync(join(worktree, "plans", "plan.json"), "{}\n");
    writeFileSync(join(worktree, "plans", "brief-99.md"), "# brief\n");

    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{
        taskNumber: 99, modifiableFiles: ["src/thing.ts"], tests: "node --test tests/thing.test.ts",
        run: {
            active: true, worktree, leaseRunId: "run-1",
            history: [{
                runId: "run-1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null,
                exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
                taskTests: {
                    stepId: "RUN_TASK_TESTS", testFiles: ["tests/thing.test.ts"], createdTestFiles: ["tests/thing.test.ts"],
                    deletedTestFiles: [], missingTests: false, passed: true, output: "SENTINEL_TASK_TEST_OUTPUT",
                    checkedAt: "2026-01-01T00:00:00.000Z",
                },
                fullSuite: null,
            }],
        },
    }]));

    return {
        box: "DO_TASK_TESTS_PASS_Q", scriptSignal: "continue",
        taskNumber: 99, runId: "run-1", projectRoot, worktree, branch: SOURCE_BRANCH,
        exitType: "", exitNote: "",
    };
}

test("test_main_printsAPromptSignal", () => {
    const output = main(JSON.stringify(makePacket()));
    assert.equal(output.box, "CODEX_REVIEWS_TESTS");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_main_printsExactlyTheContractKeys", () => {
    const output = main(JSON.stringify(makePacket()));
    assert.deepEqual(Object.keys(output).sort(), ["box", "prompt", "scriptSignal"]);
});

test("test_main_wiresThePreparedTaskIntoTheReviewPrompt", () => {
    const packet = makePacket();
    const prompt = main(JSON.stringify(packet)).prompt as string;
    assert.ok(prompt.includes(`${packet.worktree}/plans/brief-99.md`), "prompt is missing the brief path");
    assert.ok(prompt.includes(`${packet.worktree}/plans/implementation-diff-99.patch`), "prompt is missing the diff path");
});

test("test_main_throwsWhenTaskNumberIsMissing", () => {
    const packet: any = makePacket();
    delete packet.taskNumber;
    assert.throws(() => main(JSON.stringify(packet)), /taskNumber is required/);
});

test("test_main_throwsWhenRunIdIsMissing", () => {
    const packet = { ...makePacket(), runId: "" };
    assert.throws(() => main(JSON.stringify(packet)), /runId is required/);
});

test("test_main_throwsWhenBranchIsMissing", () => {
    const packet = { ...makePacket(), branch: "" };
    assert.throws(() => main(JSON.stringify(packet)), /branch is required/);
});

test("test_main_throwsWhenProjectRootIsNotAbsolute", () => {
    const packet = { ...makePacket(), projectRoot: "relative/path" };
    assert.throws(() => main(JSON.stringify(packet)), /projectRoot must be an absolute path/);
});

test("test_main_throwsWhenWorktreeIsNotAbsolute", () => {
    const packet = { ...makePacket(), worktree: "relative/worktree" };
    assert.throws(() => main(JSON.stringify(packet)), /worktree must be an absolute path/);
});

test("test_CODEX_REVIEWS_TESTS_runsTwiceWithTheSameInput", () => {
    const packet = makePacket();
    const input = JSON.stringify(packet);

    const firstOutput = main(input);
    const firstDiff = readFileSync(join(packet.worktree, "plans", "implementation-diff-99.patch"), "utf8");
    const secondOutput = main(input);
    const secondDiff = readFileSync(join(packet.worktree, "plans", "implementation-diff-99.patch"), "utf8");

    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(secondDiff, firstDiff);
});

test("test_main_leavesTheContinuationToTheEngineNotTheAgent", () => {
    const prompt = main(JSON.stringify(makePacket())).prompt as string;
    assert.doesNotMatch(prompt, /\/run-step/);
    assert.doesNotMatch(prompt, /invoke the skill/i);
});
