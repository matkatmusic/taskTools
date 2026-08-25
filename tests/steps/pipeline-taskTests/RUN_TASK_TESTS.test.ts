// Behavioral checks for scripts/steps/pipeline-taskTests/RUN_TASK_TESTS.ts.  Run: node --test tests/steps/pipeline-taskTests/RUN_TASK_TESTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-taskTests/RUN_TASK_TESTS.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../../scripts/prepareTasks.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(import.meta.dirname, "../../../scripts/steps/pipeline-taskTests/RUN_TASK_TESTS.template.json");
const FIXTURE_TASK = { taskNumber: 1, title: "fixture task" };

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), "RUN_TASK_TESTS-"));
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
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

function writePassingTest(path: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => { assert.ok(true); });\n`);
}

// Mutating: this block writes taskRunState, so every test copies the fixture into its own temp dir.
function seedOpenTaskAndClaim(root: string, taskNumber: number, runId: string, taskOverrides: Record<string, unknown> = {}): void {
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ ...FIXTURE_TASK, taskNumber, ...taskOverrides }]));
    const outcome = claimTask(taskNumber, runId, root);
    assert.equal(outcome.status, "claimed");
}

test("test_RUN_TASK_TESTS_passesWhenTheBranchAddsAPassingTest", () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    writePassingTest(join(worktreePath, "tests", "foo.test.ts"));
    git(worktreePath, "add", "tests/foo.test.ts");
    git(worktreePath, "commit", "-q", "-m", "add test");
    seedOpenTaskAndClaim(rootOrigin, 1, "run-1");

    const packet = { taskNumber: 1, runId: "run-1", worktreePath, sourceBranch: "main", projectRoot: rootOrigin };
    const output = main(JSON.stringify({ box: "COMMITTED_WORK_INPUT", scriptSignal: "continue", ...packet }));

    assert.deepEqual(output, { box: "RUN_TASK_TESTS", scriptSignal: "continue", ...packet, passed: true });
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_RUN_TASK_TESTS_failsWhenTheTaskDeclaresTestsAndTheBranchAddedNone", () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1, "run-1", { tests: "add a test for the widget" });

    const packet = { taskNumber: 1, runId: "run-1", worktreePath, sourceBranch: "main", projectRoot: rootOrigin };
    const output = main(JSON.stringify({ box: "COMMITTED_WORK_INPUT", scriptSignal: "continue", ...packet }));

    assert.deepEqual(output, { box: "RUN_TASK_TESTS", scriptSignal: "continue", ...packet, passed: false });
});
