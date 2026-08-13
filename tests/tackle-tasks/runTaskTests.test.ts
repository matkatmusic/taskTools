// Behavioral checks for scripts/tackle-tasks/runTaskTests.ts.
// Run: node --test tests/tackle-tasks/runTaskTests.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskTests } from "../../scripts/tackle-tasks/runTaskTests.ts";
import { claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), "runTaskTests-"));
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): { rootOrigin: string; childOrigin: string } {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return { rootOrigin, childOrigin };
}

let nextGroupId = 1;

function createLinkedWorktree(rootOrigin: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
}

function writePassingTest(path: string, markerFile?: { relativeToCwd: string; expectedContent: string }): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const fsImport = markerFile ? `import { readFileSync } from "node:fs";\n` : "";
    const assertion = markerFile
        ? `assert.equal(readFileSync(${JSON.stringify(markerFile.relativeToCwd)}, "utf8"), ${JSON.stringify(markerFile.expectedContent)});`
        : "assert.ok(true);";
    writeFileSync(
        path,
        `${fsImport}import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => { ${assertion} });\n`,
    );
}

function seedOpenTaskAndClaim(root: string, taskNumber: number, taskOverrides: Record<string, unknown> = {}): void {
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber, title: "t", ...taskOverrides }]));
    const outcome = claimTask(taskNumber, "run-1", root);
    assert.equal(outcome.status, "claimed");
}

test("test_runTaskTests_selectsTestFilesTheBranchAddedSinceTheSourceBranch", () => {
    // Setup: a plain repo, a linked task worktree, and a new committed test file on the branch.
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    writePassingTest(join(worktreePath, "tests", "foo.test.ts"));
    git(worktreePath, "add", "tests/foo.test.ts");
    git(worktreePath, "commit", "-q", "-m", "add test");
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the task's tests.
    const result = runTaskTests(1, worktreePath, "main", "step-1", rootOrigin);

    // Verification: the newly added test file is selected and the run passes.
    assert.deepEqual(result.testFiles, ["tests/foo.test.ts"]);
    assert.deepEqual(result.createdTestFiles, ["tests/foo.test.ts"]);
    assert.equal(result.missingTests, false);
    assert.equal(result.passed, true);
});

test("test_runTaskTests_ignoresATestFileThatIsOnTheSourceBranch", () => {
    // Setup: a test file already committed on the source branch, before the worktree exists.
    const rootOrigin = makeTempRepoWithCommit("main");
    mkdirSync(join(rootOrigin, "tests"), { recursive: true });
    writePassingTest(join(rootOrigin, "tests", "existing.test.ts"));
    git(rootOrigin, "add", "tests/existing.test.ts");
    git(rootOrigin, "commit", "-q", "-m", "existing test");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the task's tests without adding anything new.
    const result = runTaskTests(1, worktreePath, "main", "step-1", rootOrigin);

    // Verification: the pre-existing test is not picked up.
    assert.deepEqual(result.testFiles, []);
    assert.equal(result.missingTests, false);
    assert.equal(result.passed, true);
});

test("test_runTaskTests_stillSelectsTheTestsWhenTheWorktreeIsClean", () => {
    // Setup: a committed test file on the branch, with a clean working tree afterward.
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    writePassingTest(join(worktreePath, "tests", "foo.test.ts"));
    git(worktreePath, "add", "tests/foo.test.ts");
    git(worktreePath, "commit", "-q", "-m", "add test");
    seedOpenTaskAndClaim(rootOrigin, 1);
    assert.equal(git(worktreePath, "status", "--porcelain"), "");

    // Test action: run the task's tests against a clean worktree.
    const result = runTaskTests(1, worktreePath, "main", "step-1", rootOrigin);

    // Verification: discovery reads the branch, so a clean working tree still finds the test.
    assert.deepEqual(result.testFiles, ["tests/foo.test.ts"]);
});

test("test_runTaskTests_separatesCreatedTestsFromModifiedExistingTests", () => {
    // Setup: an existing test file on the source branch, and a worktree that both modifies it
    // and adds a brand-new one.
    const rootOrigin = makeTempRepoWithCommit("main");
    mkdirSync(join(rootOrigin, "tests"), { recursive: true });
    writePassingTest(join(rootOrigin, "tests", "existing.test.ts"));
    git(rootOrigin, "add", "tests/existing.test.ts");
    git(rootOrigin, "commit", "-q", "-m", "existing test");
    const worktreePath = createLinkedWorktree(rootOrigin);
    writeFileSync(
        join(worktreePath, "tests", "existing.test.ts"),
        `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => { assert.ok(true); });\n// modified\n`,
    );
    writePassingTest(join(worktreePath, "tests", "new.test.ts"));
    git(worktreePath, "add", "tests/existing.test.ts", "tests/new.test.ts");
    git(worktreePath, "commit", "-q", "-m", "modify and add");
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the task's tests.
    const result = runTaskTests(1, worktreePath, "main", "step-1", rootOrigin);

    // Verification: both are testFiles, only the new one is createdTestFiles.
    assert.deepEqual(result.testFiles.sort(), ["tests/existing.test.ts", "tests/new.test.ts"]);
    assert.deepEqual(result.createdTestFiles, ["tests/new.test.ts"]);
});

test("test_runTaskTests_findsATestFileInsideASubmodule", () => {
    // Setup: a source repo with a submodule, and a new test file committed inside the
    // submodule's occurrence of the linked worktree.
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const childCheckout = join(worktreePath, "child");
    mkdirSync(join(childCheckout, "tests"), { recursive: true });
    writePassingTest(join(childCheckout, "tests", "child.test.ts"));
    git(childCheckout, "add", "tests/child.test.ts");
    git(childCheckout, "commit", "-q", "-m", "add child test");
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the task's tests.
    const result = runTaskTests(1, worktreePath, "main", "step-1", rootOrigin);

    // Verification: the submodule's test file is tagged with its occurrence id.
    assert.deepEqual(result.testFiles, ["child::tests/child.test.ts"]);
    assert.deepEqual(result.createdTestFiles, ["child::tests/child.test.ts"]);
});

test("test_runTaskTests_runsASubmodulesTestsInsideThatSubmodule", () => {
    // Setup: a submodule test file that only passes when its cwd is the submodule checkout.
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const childCheckout = join(worktreePath, "child");
    writeFileSync(join(childCheckout, "marker.txt"), "child-marker");
    mkdirSync(join(childCheckout, "tests"), { recursive: true });
    writePassingTest(
        join(childCheckout, "tests", "child.test.ts"),
        { relativeToCwd: "marker.txt", expectedContent: "child-marker" },
    );
    git(childCheckout, "add", "tests/child.test.ts", "marker.txt");
    git(childCheckout, "commit", "-q", "-m", "add child test");
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the task's tests.
    const result = runTaskTests(1, worktreePath, "main", "step-1", rootOrigin);

    // Verification: the test ran with the submodule as its cwd, so it passed.
    assert.equal(result.passed, true);
});

test("test_runTaskTests_reportsMissingTestsWhenTheTaskDeclaresTestsAndTheBranchAddedNone", () => {
    // Setup: a task that declares tests, and a branch that added none.
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1, { tests: "add a test for the widget" });

    // Test action: run the task's tests.
    const result = runTaskTests(1, worktreePath, "main", "step-1", rootOrigin);

    // Verification: the empty set is a red result, not an automatic pass.
    assert.equal(result.missingTests, true);
    assert.equal(result.passed, false);
    assert.equal(result.output, "the task declares tests but the branch added none");
});

test("test_runTaskTests_recordsItsWholeDecisionBeforePrinting", () => {
    // Setup: a task with a new committed test file.
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    writePassingTest(join(worktreePath, "tests", "foo.test.ts"));
    git(worktreePath, "add", "tests/foo.test.ts");
    git(worktreePath, "commit", "-q", "-m", "add test");
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the task's tests.
    const result = runTaskTests(1, worktreePath, "main", "step-9", rootOrigin);

    // Verification: the stored run record's taskTests matches the returned decision.
    const stored = getCurrentTaskRun(1, rootOrigin)?.taskTests;
    assert.ok(stored);
    assert.equal(stored?.stepId, "step-9");
    assert.equal(stored?.passed, result.passed);
    assert.deepEqual(stored?.testFiles, result.testFiles);
    assert.deepEqual(stored?.createdTestFiles, result.createdTestFiles);
    assert.equal(stored?.missingTests, result.missingTests);
    assert.equal(stored?.output, result.output);
    assert.ok(stored?.checkedAt);
});
