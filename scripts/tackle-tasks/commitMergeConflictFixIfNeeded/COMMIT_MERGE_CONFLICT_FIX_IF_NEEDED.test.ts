// Behavioral checks for COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts. Ported from pipeline-rebase's archived test, against the new packet contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts";
import type { CommitMergeConflictFixIfNeededPacket } from "./_packet.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { claimTask, getCurrentTaskRun } from "../shared/taskRunState.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";
import { createWorktreeForGroup } from "../../shared/prepareTasks.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.template.json");

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("commit-conflict-fix-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskNumber: groupId };
}

function seedTaskAndMarkActiveAndLock(projectRoot: string, taskNumber: number, title: string, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title, files: ["resolved.txt"] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    const lockOutcome = acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));
    assert.equal(lockOutcome.status, "acquired");
}

function answer(projectRoot: string, worktree: string, taskNumber: number, runId: string): string {
    const packet: CommitMergeConflictFixIfNeededPacket = {
        box: "FIX_CONFLICTS", scriptSignal: "continue", taskNumber, runId, projectRoot, worktree, branch: `task-${taskNumber}`,
        exitType: "", exitNote: "", message: "resolved the conflict", additionalData: {}, stoppedOccurrenceId: "",
        stoppedCheckoutPath: worktree, conflictedFilePaths: [], conflicted: true, finished: false, failureReason: "",
    };
    return JSON.stringify(packet);
}

test("test_COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED_commitsWhateverTheFixLeftDirty", () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndMarkActiveAndLock(rootOrigin, taskNumber, "fix a conflict", "run-1");
    writeFileSync(join(worktreePath, "resolved.txt"), "resolved\n");

    const output = main(answer(rootOrigin, worktreePath, taskNumber, "run-1"));

    assert.equal(output.box, "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED");
    assert.equal(git(worktreePath, "status", "--porcelain"), "");
    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.equal(run?.commits.length, 1);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED_runsTwiceWithTheSameInput", () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndMarkActiveAndLock(rootOrigin, taskNumber, "fix a conflict", "run-3");
    writeFileSync(join(worktreePath, "resolved.txt"), "resolved\n");
    const input = answer(rootOrigin, worktreePath, taskNumber, "run-3");

    const first = main(input);
    const logAfterFirst = git(worktreePath, "log", "--format=%H %s");
    const runAfterFirst = getCurrentTaskRun(taskNumber, rootOrigin);

    const second = main(input);
    const logAfterSecond = git(worktreePath, "log", "--format=%H %s");
    const runAfterSecond = getCurrentTaskRun(taskNumber, rootOrigin);

    assert.deepEqual(second, first);
    assert.equal(logAfterSecond, logAfterFirst);
    assert.deepEqual(runAfterSecond, runAfterFirst);
});

test("test_COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED_carriesTheStoppedLayerThroughUnchangedForContinueRebase", () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndMarkActiveAndLock(rootOrigin, taskNumber, "fix a conflict", "run-2");
    writeFileSync(join(worktreePath, "resolved.txt"), "resolved\n");

    const output = main(answer(rootOrigin, worktreePath, taskNumber, "run-2"));

    assert.equal(output.stoppedCheckoutPath, worktreePath);
    assert.equal(output.conflicted, true);
});
