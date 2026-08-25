// Behavioral checks for scripts/steps/pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts. Run: node --test tests/steps/pipeline-reviewTests/CODEX_REVIEWS_TESTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts";

const SOURCE_BRANCH = "main";

// tasks.json + a recorded task-test run, matching what loadPreparedTask and getCurrentTaskRun expect.
function writeTaskState(projectRoot: string, worktree: string): void {
    mkdirSync(join(projectRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 99,
        files: ["src/thing.ts"],
        tests: "node --test tests/thing.test.ts",
        run: {
            active: true,
            worktree,
            leaseRunId: "run-1",
            history: [{
                runId: "run-1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null,
                exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
                taskTests: {
                    stepId: "RUN_TASK_TESTS", testFiles: [], createdTestFiles: [], deletedTestFiles: [],
                    missingTests: false, passed: true, output: "SENTINEL_TASK_TEST_OUTPUT", checkedAt: "2026-01-01T00:00:00.000Z",
                },
                fullSuite: null,
            }],
        },
    }]));
}

function makePacket() {
    const projectRoot = mkdtempSync(join(tmpdir(), "review-tests-"));
    const worktree = join(projectRoot, "worktree");
    const git = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    for (const dir of ["plans", "src", "tests"]) mkdirSync(join(worktree, dir), { recursive: true });
    git("init", "--quiet", `--initial-branch=${SOURCE_BRANCH}`);
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(worktree, "src", "thing.ts"), "export const thing = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "task-99");
    writeFileSync(join(worktree, "src", "thing.ts"), "export const thing = 2;\n");
    writeFileSync(join(worktree, "tests", "thing.test.ts"), "// SENTINEL_TASK_TEST\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "task work");
    writeFileSync(join(worktree, "plans", "plan.json"), "{}\n");
    writeFileSync(join(worktree, "plans", "brief-99.md"), "# brief\n");
    writeFileSync(join(worktree, "tests", "older.test.ts"), "// old\n");
    writeTaskState(projectRoot, worktree);

    return {
        box: "GREEN_IMPLEMENTATION_INPUT", scriptSignal: "continue",
        projectRoot, taskNumber: 99, worktreePath: worktree, sourceBranch: SOURCE_BRANCH, runId: "run-1",
    };
}

test("test_main_printsAPromptSignal", () => {
    const output = main(JSON.stringify(makePacket()));
    assert.equal(output.box, "CODEX_REVIEWS_TESTS");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_main_namesTheBriefPlanAndTestFilesForTheReviewer", () => {
    const packet = makePacket();
    main(JSON.stringify(packet));
    const promptFileContents = readFileSync(join(packet.worktreePath, "plans/CODEX_REVIEWS_TESTS.prompt.md"), "utf8");
    const briefFile = `${packet.worktreePath}/plans/brief-${packet.taskNumber}.md`;
    const planFile = `${packet.worktreePath}/plans/plan.json`;
    const testFile = `${packet.worktreePath}/tests/thing.test.ts`;
    for (const path of [briefFile, planFile, testFile]) {
        assert.ok(promptFileContents.includes(path), `prompt file is missing ${path}`);
    }
});

test("test_main_everyCliLineRedirectsStdinAndCodexIsSchemaBound", () => {
    const prompt = main(JSON.stringify(makePacket())).prompt as string;
    const cliLines = prompt.split("\n").filter((line) => /^(codex exec|\s*\|\| claude -p)/.test(line));
    assert.equal(cliLines.length, 3);
    for (const line of cliLines) assert.match(line, /<\/dev\/null/);
    assert.match(cliLines[0]!, /--output-schema \S*review-tests-schema\.json/);
});

test("test_main_forbidsRunningTheTests", () => {
    const packet = makePacket();
    main(JSON.stringify(packet));
    const promptFileContents = readFileSync(join(packet.worktreePath, "plans/CODEX_REVIEWS_TESTS.prompt.md"), "utf8");
    assert.match(promptFileContents, /Never run a test, and never run the full suite\./);
});

test("test_main_writesTheImplementationDiffAndNamesItForTheReviewer", () => {
    const packet = makePacket();
    main(JSON.stringify(packet));
    const promptFileContents = readFileSync(join(packet.worktreePath, "plans/CODEX_REVIEWS_TESTS.prompt.md"), "utf8");
    const diffPath = `${packet.worktreePath}/plans/implementation-diff-99.patch`;
    assert.ok(promptFileContents.includes(diffPath), "prompt file is missing the diff path");
    assert.match(readFileSync(diffPath, "utf8"), /-export const thing = 1;/);
});

test("test_main_separatesTestsThisTaskDidNotCreate", () => {
    // older.test.ts pairs with the also-owned src/older.ts and predates the task branch; thing.test.ts is new on task-99.
    const projectRoot = mkdtempSync(join(tmpdir(), "review-tests-"));
    const worktree = join(projectRoot, "worktree");
    const git = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    for (const dir of ["plans", "src", "tests"]) mkdirSync(join(worktree, dir), { recursive: true });
    git("init", "--quiet", `--initial-branch=${SOURCE_BRANCH}`);
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(worktree, "src", "thing.ts"), "export const thing = 1;\n");
    writeFileSync(join(worktree, "src", "older.ts"), "export const older = 1;\n");
    writeFileSync(join(worktree, "tests", "older.test.ts"), "// old\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "task-99");
    writeFileSync(join(worktree, "src", "thing.ts"), "export const thing = 2;\n");
    writeFileSync(join(worktree, "tests", "thing.test.ts"), "// SENTINEL_TASK_TEST\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "task work");
    writeFileSync(join(worktree, "plans", "plan.json"), "{}\n");
    writeFileSync(join(worktree, "plans", "brief-99.md"), "# brief\n");

    mkdirSync(join(projectRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 99,
        files: ["src/thing.ts", "src/older.ts"],
        tests: "node --test tests/thing.test.ts",
        run: {
            active: true, worktree, leaseRunId: "run-1",
            history: [{
                runId: "run-1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null,
                exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
                taskTests: {
                    stepId: "RUN_TASK_TESTS", testFiles: [], createdTestFiles: [], deletedTestFiles: [],
                    missingTests: false, passed: true, output: "SENTINEL_TASK_TEST_OUTPUT", checkedAt: "2026-01-01T00:00:00.000Z",
                },
                fullSuite: null,
            }],
        },
    }]));

    const packet = {
        box: "GREEN_IMPLEMENTATION_INPUT", scriptSignal: "continue",
        projectRoot, taskNumber: 99, worktreePath: worktree, sourceBranch: SOURCE_BRANCH, runId: "run-1",
    };

    main(JSON.stringify(packet));
    const promptFileContents = readFileSync(join(worktree, "plans/CODEX_REVIEWS_TESTS.prompt.md"), "utf8");
    assert.match(promptFileContents, /## TESTS THIS TASK DID NOT CREATE\n\n- .*tests\/older\.test\.ts/);
    assert.equal(promptFileContents.includes(`- ${join(worktree, "tests", "thing.test.ts")}\n\nA test in that list`), false);
});

test("test_main_carriesTheTestCommandAndItsRecordedOutput", () => {
    const packet = makePacket();
    main(JSON.stringify(packet));
    const promptFileContents = readFileSync(join(packet.worktreePath, "plans/CODEX_REVIEWS_TESTS.prompt.md"), "utf8");
    assert.match(promptFileContents, /ran as `node --test tests\/thing\.test\.ts`/);
    assert.match(promptFileContents, /SENTINEL_TASK_TEST_OUTPUT/);
});

test("test_main_leavesTheContinuationToTheEngineNotTheAgent", () => {
    const prompt = main(JSON.stringify(makePacket())).prompt as string;
    assert.doesNotMatch(prompt, /\/run-step/);
    assert.match(prompt, /Never decide that verdict yourself/);
});
