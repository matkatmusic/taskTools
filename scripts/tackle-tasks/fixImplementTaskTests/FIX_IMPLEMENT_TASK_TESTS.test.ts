// Behavioral checks for scripts/tackle-tasks/fixImplementTaskTests/FIX_IMPLEMENT_TASK_TESTS.ts. Run: node --test scripts/tackle-tasks/fixImplementTaskTests/FIX_IMPLEMENT_TASK_TESTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./FIX_IMPLEMENT_TASK_TESTS.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "fix-implement-task-tests-run-log.json");

function setupFixture(): { projectRoot: string; worktree: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "fix-implement-task-tests-project-"));
    const worktree = mkdtempSync(join(tmpdir(), "fix-implement-task-tests-worktree-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([
        { taskNumber: 1, files: ["a.ts"], codexReviewNotes: "the failing test notes text" },
    ]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", "brief-1.md"), "# fixture brief");
    writeFileSync(join(worktree, "a.ts"), "export const thing = 1;\n");
    return { projectRoot, worktree };
}

function packet(projectRoot: string, worktree: string): string {
    return JSON.stringify({
        box: "AMEND_ENTRY_WITH_FAILING_TESTS", scriptSignal: "continue",
        taskNumber: 1, runId: "run-1", projectRoot, worktree, branch: "task-1",
        exitType: "", exitNote: "", message: "", additionalData: {},
    });
}

test("test_FIX_IMPLEMENT_TASK_TESTS_printsThePromptContractShape", () => {
    const { projectRoot, worktree } = setupFixture();
    const output = main(packet(projectRoot, worktree));
    assert.equal(output.box, "FIX_IMPLEMENT_TASK_TESTS");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_FIX_IMPLEMENT_TASK_TESTS_namesTheOwnedFilesAndTheFailingNotes", () => {
    const { projectRoot, worktree } = setupFixture();
    main(packet(projectRoot, worktree));
    const promptFileContents = readFileSync(join(worktree, "plans", "FIX_IMPLEMENT_TASK_TESTS.prompt.md"), "utf8");
    assert.match(promptFileContents, new RegExp(`${worktree}/a\\.ts`));
    assert.match(promptFileContents, /the failing test notes text/);
});

test("test_FIX_IMPLEMENT_TASK_TESTS_runsTwiceWithTheSameInput", () => {
    const { projectRoot, worktree } = setupFixture();
    const input = packet(projectRoot, worktree);

    const firstOutput = main(input);
    const firstPrompt = readFileSync(join(worktree, "plans", "FIX_IMPLEMENT_TASK_TESTS.prompt.md"), "utf8");
    const secondOutput = main(input);
    const secondPrompt = readFileSync(join(worktree, "plans", "FIX_IMPLEMENT_TASK_TESTS.prompt.md"), "utf8");

    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(secondPrompt, firstPrompt);
});
