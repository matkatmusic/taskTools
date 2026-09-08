// Behavioral checks for COMMIT_TEST_FIX_IF_NEEDED.ts, against a temp git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./COMMIT_TEST_FIX_IF_NEEDED.ts";
import { claimTask, getCurrentTaskRun } from "../shared/taskRunState.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";

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
    const projectRoot = makeTempGitRepo("commit-test-fix-if-needed-root-");
    const worktree = makeTempGitRepo("commit-test-fix-if-needed-worktree-");
    writeJsonAtomically(join(projectRoot, "tasks.json"), [{ taskNumber, title: "widget", modifiableFiles: ["widget.txt"] }]);
    const outcome = claimTask(taskNumber, "run-1", projectRoot);
    assert.equal(outcome.status, "claimed");
    return { projectRoot, worktree };
}

const corePacket = (projectRoot: string, worktree: string, taskNumber: number) => ({
    box: "FIX_IMPLEMENT_TASK_TESTS", scriptSignal: "continue", taskNumber, runId: "run-1",
    projectRoot, worktree, branch: "task-1", exitType: "", exitNote: "",
});

test("test_main_commitsADirtyWorktreeAndDropsTheAgentAnswer", () => {
    const taskNumber = 9201;
    const { projectRoot, worktree } = makeFixture(taskNumber);
    writeFileSync(join(worktree, "widget.txt"), "widget\n");

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "fixed the failing test", additionalData: { fixSummary: "renamed the assertion" } };
    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...corePacket(projectRoot, worktree, taskNumber), box: "COMMIT_TEST_FIX_IF_NEEDED", scriptSignal: "continue", next: "ARE_TASK_TESTS_SKIPPED_Q" });
    assert.equal(getCurrentTaskRun(taskNumber, projectRoot)?.commits.length, 1);
});

test("test_main_returnsCleanlyWhenTheWorktreeIsAlreadyClean", () => {
    const taskNumber = 9202;
    const { projectRoot, worktree } = makeFixture(taskNumber);

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "", additionalData: { fixSummary: "renamed the assertion" } };
    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...corePacket(projectRoot, worktree, taskNumber), box: "COMMIT_TEST_FIX_IF_NEEDED", scriptSignal: "continue", next: "ARE_TASK_TESTS_SKIPPED_Q" });
    assert.deepEqual(getCurrentTaskRun(taskNumber, projectRoot)?.commits, []);
});

test("test_main_throwsWhenAdditionalDataHasNoStringFixSummary", () => {
    const taskNumber = 9203;
    const { projectRoot, worktree } = makeFixture(taskNumber);

    const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "?", additionalData: {} };

    assert.throws(() => main(JSON.stringify(input)), /additionalData holds no string "fixSummary"/);
});
