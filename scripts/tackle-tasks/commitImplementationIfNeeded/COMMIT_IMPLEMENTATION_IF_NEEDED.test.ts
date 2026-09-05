// Behavioral checks for COMMIT_IMPLEMENTATION_IF_NEEDED.ts, against a temp git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./COMMIT_IMPLEMENTATION_IF_NEEDED.ts";
import { claimTask, getCurrentTaskRun } from "../shared/taskRunState.ts";
import { stagingWorktreePath } from "../shared/stagingWorktree.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempGitRepo(prefix: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), prefix));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "fixture@example.com");
    git(repoPath, "config", "user.name", "fixture");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    git(repoPath, "branch", "staging");
    return repoPath;
}

// projectRoot (task state) and worktree (the checkout being committed) are separate repos, like production.
function makeFixture(taskNumber: number): { projectRoot: string; worktree: string } {
    const projectRoot = makeTempGitRepo("commit-implementation-if-needed-root-");
    const worktree = makeTempGitRepo("commit-implementation-if-needed-worktree-");
    writeJsonAtomically(join(projectRoot, "tasks.json"), [{ taskNumber, title: "widget", files: ["widget.txt"] }]);
    const outcome = claimTask(taskNumber, "run-1", projectRoot);
    assert.equal(outcome.status, "claimed");
    return { projectRoot, worktree };
}

const corePacket = (projectRoot: string, worktree: string, taskNumber: number) => ({
    box: "IMPLEMENT_TASK", scriptSignal: "continue", taskNumber, runId: "run-1",
    projectRoot, worktree, branch: "task-1", exitType: "", exitNote: "",
});

test("test_main_commitsADirtyWorktreeAndDropsTheAgentAnswer", () => {
    const taskNumber = 9101;
    const { projectRoot, worktree } = makeFixture(taskNumber);
    writeFileSync(join(worktree, "widget.txt"), "widget\n");

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "implemented", additionalData: { implemented: true, notes: "" } };
    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...corePacket(projectRoot, worktree, taskNumber), box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: "continue", next: "ARE_TASK_TESTS_SKIPPED_Q" });
    assert.equal(getCurrentTaskRun(taskNumber, projectRoot)?.commits.length, 1);
});

test("test_main_returnsCleanlyWhenTheWorktreeIsAlreadyClean", () => {
    const taskNumber = 9102;
    const { projectRoot, worktree } = makeFixture(taskNumber);

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "", additionalData: { implemented: true, notes: "" } };
    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...corePacket(projectRoot, worktree, taskNumber), box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: "continue", next: "ARE_TASK_TESTS_SKIPPED_Q" });
    assert.deepEqual(getCurrentTaskRun(taskNumber, projectRoot)?.commits, []);
});

test("test_COMMIT_IMPLEMENTATION_IF_NEEDED_runsTwiceWithTheSameInput", () => {
    const taskNumber = 9103;
    const { projectRoot, worktree } = makeFixture(taskNumber);
    writeFileSync(join(worktree, "widget.txt"), "widget\n");

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "implemented", additionalData: { implemented: true, notes: "" } };
    const firstOutput = main(JSON.stringify(input));
    const secondOutput = main(JSON.stringify(input));

    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(getCurrentTaskRun(taskNumber, projectRoot)?.commits.length, 1);
    assert.equal(git(worktree, "log", "--oneline").split("\n").length, 2);
});

test("test_main_usesStagingAsTheBaseBranchWhenTheSourceCheckoutIsOnAnotherBranch", () => {
    const taskNumber = 9104;
    const { projectRoot, worktree } = makeFixture(taskNumber);
    git(projectRoot, "checkout", "-q", "-b", "feature-branch");
    writeFileSync(join(worktree, "widget.txt"), "widget\n");

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "implemented", additionalData: { implemented: true, notes: "" } };
    main(JSON.stringify(input));

    assert.equal(git(stagingWorktreePath(projectRoot), "branch", "--show-current"), "staging");
});

test("test_main_throwsWhenAdditionalDataHasNoBooleanImplemented", () => {
    const taskNumber = 9105;
    const { projectRoot, worktree } = makeFixture(taskNumber);

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "?", additionalData: { ok: true } };

    assert.throws(() => main(JSON.stringify(input)), /additionalData holds no boolean "implemented"/);
});

test("test_main_routesToFailuresExitWhenImplementedIsFalse", () => {
    const taskNumber = 9106;
    const { projectRoot, worktree } = makeFixture(taskNumber);

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "gave up", additionalData: { implemented: false, notes: "an open question blocks the plan" } };
    const output = main(JSON.stringify(input));

    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.notEqual(output.exitType, "");
    assert.equal(output.exitNote, "an open question blocks the plan");
    assert.deepEqual(getCurrentTaskRun(taskNumber, projectRoot)?.commits, []);
});

// Retired: the fixSummary path now belongs to COMMIT_TEST_FIX_IF_NEEDED, reached via FIX_IMPLEMENT_TASK_TESTS directly.
// test("test_main_doesNotThrowWhenReachedFromTheTestFixPathWithNoImplementedKey", () => {
//     const taskNumber = 9107;
//     const { projectRoot, worktree } = makeFixture(taskNumber);
//
//     const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "fixed the failing test", additionalData: { fixSummary: "renamed the assertion" } };
//     const output = main(JSON.stringify(input));
//
//     assert.equal(output.next, "ARE_TASK_TESTS_SKIPPED_Q");
// });

test("test_main_throwsWhenAdditionalDataHasOnlyFixSummary", () => {
    const taskNumber = 9107;
    const { projectRoot, worktree } = makeFixture(taskNumber);

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "fixed the failing test", additionalData: { fixSummary: "renamed the assertion" } };

    assert.throws(() => main(JSON.stringify(input)), /additionalData holds no boolean "implemented"/);
});
