// Behavioral checks for scripts/steps/pipeline-rebase/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts.  Ported from tests/commitTaskWork.test.ts, against the new agent-answer envelope contract.  Run: node --test tests/steps/pipeline-rebase/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-rebase/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { claimTask, getCurrentTaskRun } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";
import { createWorktreeForGroup } from "../../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-rebase/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.template.json");

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

function seedTaskAndClaimAndLock(projectRoot: string, taskNumber: number, title: string, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title, files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    const lockOutcome = acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));
    assert.equal(lockOutcome.status, "acquired");
}

function answer(projectRoot: string, worktreePath: string, taskNumber: number, runId: string, stepId: string): string {
    const packet: RebasePacket = {
        box: "ARE_2_CONFLICT_FIXES_DONE", scriptSignal: "continue", projectRoot, worktreePath, taskNumber, runId, stepId,
        rootSourceBranch: "main", landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: true, stoppedOccurrenceId: "",
        stoppedCheckoutPath: worktreePath, conflictedFilePaths: [], finished: false, failureReason: "", exitType: "", exitNote: "",
    };
    return JSON.stringify({ ...packet, next: "FIX_CONFLICTS", resolved: true, unresolvedPaths: [] });
}

test("test_COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED_commitsWhateverTheFixLeftDirty", () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaimAndLock(rootOrigin, taskNumber, "fix a conflict", "run-1");
    writeFileSync(join(worktreePath, "resolved.txt"), "resolved\n");

    const output = main(answer(rootOrigin, worktreePath, taskNumber, "run-1", "step-1"));

    assert.equal(output.box, "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED");
    assert.equal(git(worktreePath, "status", "--porcelain"), "");
    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.equal(run?.commits.length, 1);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED_carriesTheStoppedLayerThroughUnchangedForContinueRebase", () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaimAndLock(rootOrigin, taskNumber, "fix a conflict", "run-2");
    writeFileSync(join(worktreePath, "resolved.txt"), "resolved\n");

    const output = main(answer(rootOrigin, worktreePath, taskNumber, "run-2", "step-1"));

    assert.equal(output.stoppedCheckoutPath, worktreePath);
    assert.equal(output.conflicted, true);
});
