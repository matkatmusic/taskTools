// Behavioral checks for CODEX_TEST_REVIEW_FALLBACK_OPUS.ts: retries the review question with claude opus only, no chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./CODEX_TEST_REVIEW_FALLBACK_OPUS.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "codex-test-review-fallback-opus-run-log.json");

const SOURCE_BRANCH = "main";

function makePacket() {
    const projectRoot = mkdtempSync(join(tmpdir(), "codex-test-review-fallback-opus-"));
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
        box: "DID_FABLE_TEST_REVIEW_SUCCEED_Q", scriptSignal: "continue",
        taskNumber: 99, runId: "run-1", projectRoot, worktree, branch: SOURCE_BRANCH,
        exitType: "", exitNote: "",
    };
}

test("test_main_returnsAPromptSignal", () => {
    const output = main(JSON.stringify(makePacket()));
    assert.equal(output.box, "CODEX_TEST_REVIEW_FALLBACK_OPUS");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_main_asksTheAgentToReviewItselfWithNoCli", () => {
    const prompt = main(JSON.stringify(makePacket())).prompt as string;
    assert.match(prompt, /## YOU ARE THE FALLBACK REVIEWER/);
    assert.equal(prompt.includes("claude -p"), false);
    assert.equal(prompt.includes("codex exec"), false);
    assert.equal(prompt.includes("||"), false);
});

test("test_main_leavesTheContinuationToTheEngineNotTheAgent", () => {
    const prompt = main(JSON.stringify(makePacket())).prompt as string;
    assert.doesNotMatch(prompt, /\/run-step/);
    assert.doesNotMatch(prompt, /invoke the skill/i);
});
