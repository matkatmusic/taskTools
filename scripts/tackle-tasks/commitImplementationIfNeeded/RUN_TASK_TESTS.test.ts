// Behavioral checks for RUN_TASK_TESTS.ts, against a temp git repo and a real linked worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./RUN_TASK_TESTS.ts";
import { claimTask, getCurrentTaskRun } from "../shared/taskRunState.ts";
import { createWorktreeForGroup } from "../../shared/prepareTasks.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "run-task-tests-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "fixture@example.com");
    git(repoPath, "config", "user.name", "fixture");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
}

function seedOpenTaskAndClaim(root: string, taskNumber: number, overrides: Record<string, unknown> = {}): void {
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture task", ...overrides }]));
    const outcome = claimTask(taskNumber, "run-1", root);
    assert.equal(outcome.status, "claimed");
}

function packet(projectRoot: string, worktree: string, taskNumber: number) {
    return { box: "ARE_TASK_TESTS_SKIPPED_Q", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot, worktree, branch: "task-1", exitType: "", exitNote: "" };
}

test("test_main_recordsAPassWhenTheBranchAddsAPassingTest", () => {
    const rootOrigin = makeTempRepoWithCommit();
    const worktree = createLinkedWorktree(rootOrigin);
    mkdirSync(join(worktree, "tests"), { recursive: true });
    writeFileSync(join(worktree, "tests", "foo.test.ts"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => { assert.ok(true); });\n`);
    git(worktree, "add", "tests/foo.test.ts");
    git(worktree, "commit", "-q", "-m", "add test");
    seedOpenTaskAndClaim(rootOrigin, 1);

    const input = packet(rootOrigin, worktree, 1);
    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...input, box: "RUN_TASK_TESTS" });
    assert.equal(getCurrentTaskRun(1, rootOrigin)?.taskTests?.passed, true);
});

test("test_main_recordsAFailWhenTheTaskDeclaresTestsAndTheBranchAddedNone", () => {
    const rootOrigin = makeTempRepoWithCommit();
    const worktree = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 2, { tests: "add a test for the widget" });

    const input = packet(rootOrigin, worktree, 2);
    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...input, box: "RUN_TASK_TESTS" });
    assert.equal(getCurrentTaskRun(2, rootOrigin)?.taskTests?.passed, false);
});

test("test_RUN_TASK_TESTS_runsTwiceWithTheSameInput", () => {
    const rootOrigin = makeTempRepoWithCommit();
    const worktree = createLinkedWorktree(rootOrigin);
    mkdirSync(join(worktree, "tests"), { recursive: true });
    writeFileSync(join(worktree, "tests", "foo.test.ts"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => { assert.ok(true); });\n`);
    git(worktree, "add", "tests/foo.test.ts");
    git(worktree, "commit", "-q", "-m", "add test");
    seedOpenTaskAndClaim(rootOrigin, 3);

    const input = packet(rootOrigin, worktree, 3);
    // checkedAt and output embed real wall-clock timing (node --test stamps its own duration); everything else must match.
    const firstOutput = main(JSON.stringify(input));
    const { checkedAt: _firstCheckedAt, output: _firstOutputText, ...firstTaskTests } = getCurrentTaskRun(3, rootOrigin)?.taskTests ?? {};
    const secondOutput = main(JSON.stringify(input));
    const { checkedAt: _secondCheckedAt, output: _secondOutputText, ...secondTaskTests } = getCurrentTaskRun(3, rootOrigin)?.taskTests ?? {};

    assert.deepEqual(secondOutput, firstOutput);
    assert.deepEqual(secondTaskTests, firstTaskTests);
});
