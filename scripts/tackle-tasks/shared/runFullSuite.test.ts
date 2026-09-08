// Behavioral checks for scripts/tackle-tasks/runFullSuite.ts.  Run: node --test tests/runFullSuite.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFullSuite } from "./runFullSuite.ts";
import { claimTask, endTaskRun, getCurrentTaskRun } from "./taskRunState.ts";
import { createWorktreeForGroup } from "../../shared/prepareTasks.ts";
import { writeKnownFailingTests } from "../../shared/taskTestsRunner.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), "runFullSuite-"));
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function writePackageJsonWithTestExitCode(repoPath: string, exitCode: number): void {
    writeFileSync(
        join(repoPath, "package.json"),
        JSON.stringify({ name: "fixture", scripts: { test: `node -e "process.exit(${exitCode})"` } }),
    );
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "add test script");
}

// A test script that prints a real reporter-shaped failure, so parseFailingTests can name it.
function writePackageJsonWithReporterFailure(repoPath: string, file: string, name: string): void {
    const reporterTail = `✖ ${name} (1ms)\\nℹ fail 1\\n✖ failing tests:\\n\\ntest at ${file}:12:1\\n✖ ${name} (1ms)\\n`;
    writeFileSync(
        join(repoPath, "package.json"),
        JSON.stringify({ name: "fixture", scripts: { test: `printf '${reporterTail}'; exit 1` } }),
    );
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "add test script");
}

let nextGroupId = 1;

function createLinkedWorktree(rootOrigin: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
}

function seedOpenTaskAndClaim(root: string, taskNumber: number): void {
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber, title: "t" }]));
    const outcome = claimTask(taskNumber, "run-1", root);
    assert.equal(outcome.status, "claimed");
}

const RUN_ID = "run-1";

test("test_runFullSuite_failsWhenASubmoduleSuiteIsRedAndTheRootIsGreen", async () => {
    // Setup: a source repo whose root suite is green and whose submodule suite is red.
    const childOrigin = makeTempRepoWithCommit("child-main");
    writePackageJsonWithTestExitCode(childOrigin, 1);
    const rootOrigin = makeTempRepoWithCommit("main");
    writePackageJsonWithTestExitCode(rootOrigin, 0);
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the full suite.
    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin);

    // Verification: the whole run is red because the submodule layer is red, even though root is green.
    assert.equal(result.passed, false);
    const child = result.layers.find((layer) => layer.occurrenceId === "child");
    const root = result.layers.find((layer) => layer.occurrenceId === "");
    assert.equal(child?.passed, false);
    assert.equal(root?.passed, true);
});

test("test_runFullSuite_countsALayerWithNoDiscoverableSuiteAsPassed", async () => {
    // Setup: a plain repo with no package.json at all, so no complete-suite command exists.
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin);
    assert.equal(result.passed, true);
    assert.deepEqual(result.layers, [{ occurrenceId: "", passed: true }]);
    assert.match(result.output, /occurrence "" has no discoverable test suite/);
});

test("test_runFullSuite_recordsItsWholeDecisionBeforePrinting", async () => {
    // Setup: a single-layer repo with a green suite.
    const rootOrigin = makeTempRepoWithCommit("main");
    writePackageJsonWithTestExitCode(rootOrigin, 0);
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Test action: run the full suite.
    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-9", rootOrigin);

    // Verification: the stored run record's fullSuite matches the returned decision.
    const stored = getCurrentTaskRun(1, rootOrigin)?.fullSuite;
    assert.ok(stored);
    assert.equal(stored?.stepId, "step-9");
    assert.equal(stored?.passed, result.passed);
    assert.deepEqual(stored?.layers, result.layers);
    assert.equal(stored?.output, result.output);
    assert.ok(stored?.checkedAt);
});

test("test_runFullSuite_keepsALayerGreenWhenItsOnlyFailureIsKnown", async () => {
    // Setup: a layer whose one reported failure is already recorded as a known baseline.
    const rootOrigin = makeTempRepoWithCommit("main");
    writePackageJsonWithReporterFailure(rootOrigin, "tests/a.test.ts", "boom");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);
    writeKnownFailingTests(rootOrigin, [{ file: "tests/a.test.ts", name: "boom" }]);

    // Test action: run the full suite.
    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin);

    // Verification: the known failure keeps the layer, and the overall run, green.
    assert.equal(result.passed, true);
    assert.deepEqual(result.layers, [{ occurrenceId: "", passed: true }]);
    assert.match(result.output, /^known failing test \(ignored\):/);
});

test("test_runFullSuite_throwsWhenTheExpectedRunIdIsStale", async () => {
    // Setup: a claimed run ends, replaced by a newer claim, as a timed-out process still holds the old id.
    const rootOrigin = makeTempRepoWithCommit("main");
    writePackageJsonWithTestExitCode(rootOrigin, 0);
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);
    endTaskRun(1, RUN_ID, rootOrigin);
    const outcome = claimTask(1, "run-2", rootOrigin);
    assert.equal(outcome.status, "claimed");

    // Test action + verification: the stale run's write is rejected, and the new run is untouched.
    await assert.rejects(runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin), /run-2/);
    assert.equal(getCurrentTaskRun(1, rootOrigin)?.fullSuite, null);
});

test("test_runFullSuite_reportsATimeoutAsARedLayerNotAHang", async () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    writeFileSync(join(rootOrigin, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "sleep 999 & wait" } }));
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "hang");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin, 200);

    assert.equal(result.passed, false);
    assert.match(result.output, /timed out/);
});

test("test_runFullSuite_stopsRemainingLayersWhenTheTotalBudgetIsExhausted", async () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    writePackageJsonWithTestExitCode(rootOrigin, 0);
    const childOrigin = makeTempRepoWithCommit("main");
    writeFileSync(join(childOrigin, "package.json"), JSON.stringify({ name: "child", scripts: { test: "sleep 999 & wait" } }));
    git(childOrigin, "add", "package.json");
    git(childOrigin, "commit", "-q", "-m", "hang");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Total budget of 200ms: the deeper (submodule) occurrence runs first, hangs, and consumes it all.
    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin, 200);

    assert.equal(result.passed, false);
    assert.equal(result.layers.length, 2);
    assert.ok(result.layers.every((layer) => layer.passed === false));
});
