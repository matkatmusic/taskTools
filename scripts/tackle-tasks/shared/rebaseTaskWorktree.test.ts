// Behavioral checks for scripts/tackle-tasks/rebaseTaskWorktree.ts. Run: node --test tests/rebaseTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebaseTaskWorktree } from "./rebaseTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "./sourceRepoLock.ts";
import { formatSourceRepoLockRecoveryCommand } from "./recoverSourceRepoLock.ts";
import { claimTask, getCurrentTaskRun } from "./taskRunState.ts";
import { createWorktreeForGroup } from "../../shared/prepareTasks.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("rebase-worktree-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
// operationBranch is attached as "task-<taskNumber>" by the script under test, so taskNumber must equal the worktree's real groupId - matching production's one-task-per-group.
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskNumber: groupId };
}

function seedTaskAndClaim(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
}

function fastLockOptions() {
    const calls: number[] = [];
    return {
        pollIntervalMs: 5,
        timeoutMs: 30,
        sleep: async (ms: number) => { calls.push(ms); },
        calls,
    };
}

test("test_rebaseTaskWorktree_rebasesEveryLayerAndReportsNoConflicts", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-1");
    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child work");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "rebase-1", rootSourceBranch: "main",
    });

    assert.equal(output.lock, "acquired");
    assert.equal(output.conflicted, false);
    assert.equal(output.stoppedAt, null);
    assert.equal(output.failureReason, null);

    // F3: the rebase box persisted a source-tip receipt onto the current run record.
    const run = getCurrentTaskRun(taskNumber, rootOrigin) as { sourceTipsAtRebase?: { occurrenceId: string; baseBranch: string; sourceTip: string }[] } | null;
    const receipts = run?.sourceTipsAtRebase ?? [];
    assert.deepEqual(receipts.map((receipt) => receipt.occurrenceId).sort(), ["", "child"]);
    const rootReceipt = receipts.find((receipt) => receipt.occurrenceId === "")!;
    assert.equal(rootReceipt.sourceTip, git(rootOrigin, "rev-parse", "main"));
});

test("test_rebaseTaskWorktree_reacquiringItsOwnSourceLockIsANoOp", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-2");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");

    const first = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-2", stepId: "rebase-2", rootSourceBranch: "main",
    });
    assert.equal(first.lock, "acquired");

    const options = fastLockOptions();
    const second = await rebaseTaskWorktree(
        { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-2", stepId: "rebase-2", rootSourceBranch: "main" },
        options,
    );

    // Same owner re-entering: immediate no-op, never waits.
    assert.equal(second.lock, "acquired");
    assert.deepEqual(options.calls, []);
});

test("test_rebaseTaskWorktree_returnsHeldRatherThanBlockingForeverOnAnotherOwner", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const otherOwner = buildLockOwner("other-run", 99);
    const outcome = acquireSourceRepoLock(rootOrigin, otherOwner);
    assert.equal(outcome.status, "acquired");

    const output = await rebaseTaskWorktree(
        { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-3", stepId: "rebase-3", rootSourceBranch: "main" },
        { pollIntervalMs: 5, timeoutMs: 20, sleep: async () => {} },
    );

    assert.equal(output.lock, "held");
    assert.equal(output.conflicted, false);
    assert.equal(output.heldByOwner, otherOwner);
    assert.equal(output.recoveryCommand, null);
});

test("test_rebaseTaskWorktree_recoverableOutputCarriesTheOwnerAndTheExactMaintenanceCliCommand", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const staleOwner = buildLockOwner("stale-run", 5);
    acquireSourceRepoLock(rootOrigin, staleOwner, { nowMs: Date.now() - 24 * 60 * 60 * 1000 });

    const output = await rebaseTaskWorktree(
        { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-5", stepId: "rebase-5", rootSourceBranch: "main" },
        { pollIntervalMs: 5, timeoutMs: 20, sleep: async () => {} },
    );

    assert.equal(output.lock, "recoverable");
    assert.equal(output.heldByOwner, staleOwner);
    assert.equal(output.recoveryCommand, formatSourceRepoLockRecoveryCommand(rootOrigin, staleOwner));
});

test("test_rebaseTaskWorktree_reportsConflictedFilePathsForTheStoppedLayer", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-4");
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ x: "worktree" }));
    git(worktreePath, "add", "package.json");
    git(worktreePath, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(rootOrigin, "package.json"), JSON.stringify({ x: "source" }));
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "source edit");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-4", stepId: "rebase-4", rootSourceBranch: "main",
    });

    assert.equal(output.lock, "acquired");
    assert.equal(output.conflicted, true);
    assert.equal(output.stoppedAt?.occurrenceId, "");
    assert.deepEqual(output.conflictedFilePaths, ["package.json"]);
});

test("test_rebaseTaskWorktree_releasesTheSourceLockWhenAnOperationalFailureThrows", async () => {
    // Setup: a claimed task with a linked worktree; the source branch diverges so the parent
    // rebase has real work to do.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const runId = "run-throw";
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    writeFileSync(join(rootOrigin, "root-work.txt"), "root work\n");
    git(rootOrigin, "add", "root-work.txt");
    git(rootOrigin, "commit", "-q", "-m", "root work");

    // rebaseTaskWorktree always calls the parent rebase with leaveConflictLive=true, so a real
    // conflict returns "conflicted" (a normal return), never "cleanup-failed". An uncommitted
    // change in the worktree makes `git rebase` itself refuse to start (no rebase-merge directory
    // is ever created), which rebaseGroupOntoSource maps straight to "cleanup-failed" with no
    // abort attempt at all.
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ x: "dirty" }));

    // Test action: rebaseTaskWorktree throws (cleanup-failed is an operational failure, mapped to a throw).
    await assert.rejects(() => rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId, stepId: "rebase", rootSourceBranch: "main",
    }));

    // Verification: the source lock this call acquired is released, not stranded.
    assert.equal(readSourceRepoLock(rootOrigin), null);
});
