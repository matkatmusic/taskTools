// Behavioral checks for scripts/tackle-tasks/rebaseTaskWorktree.ts. Run: node --test tests/tackle-tasks/rebaseTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebaseTaskWorktree } from "../../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { reconcileStep } from "../../scripts/tackle-tasks/reconcileStep.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { formatSourceRepoLockRecoveryCommand } from "../../scripts/tackle-tasks/recoverSourceRepoLock.ts";
import { claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";

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
// operationBranch is attached as "task-<taskNumber>" by the script under test, so taskNumber
// must equal the worktree's real groupId - matching production's one-task-per-group.
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

    // F3: a root conflict result is persisted too - discard the real return, reconcile the same
    // stepId, and require the exact same conflict result back.
    const reconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-4", taskNumber, runId: "run-4", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result, output);
});

// F3: reconcileRebase checks a matching step receipt BEFORE checking "is a rebase in progress",
// so a proven root conflict receipt is replayed - not blindly rerun - while the rebase is still
// live on disk.
test("test_rebaseTaskWorktree_reconciliationReproducesARootConflictOutcomeFromTheReceipt", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-16");
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ x: "worktree" }));
    git(worktreePath, "add", "package.json");
    git(worktreePath, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(rootOrigin, "package.json"), JSON.stringify({ x: "source" }));
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "source edit");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-16", stepId: "rebase-16", rootSourceBranch: "main",
    });

    assert.equal(output.conflicted, true);
    assert.equal(output.stoppedAt?.occurrenceId, "");

    // The conflict was never resolved or aborted, so the rebase is still live in the worktree.
    const reconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-16", taskNumber, runId: "run-16", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result, output);
});

// A live conflict with no matching receipt (process died before persistRebaseStepResult ran)
// is undecidable: reconciliation must return ambiguous, never replay/rerun as not-completed.
test("test_rebaseTaskWorktree_reportsAmbiguousForALiveConflictWhoseReceiptWasNeverAppended", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-16b");
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ x: "worktree" }));
    git(worktreePath, "add", "package.json");
    git(worktreePath, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(rootOrigin, "package.json"), JSON.stringify({ x: "source" }));
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "source edit");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-16b", stepId: "rebase-16b", rootSourceBranch: "main",
    });
    assert.equal(output.conflicted, true);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    const task = tasks.find((t: { taskNumber: number }) => t.taskNumber === taskNumber);
    const latestRun = task.run.history[task.run.history.length - 1];
    latestRun.stepResults = (latestRun.stepResults ?? []).filter(
        (entry: { stepId: string }) => entry.stepId !== "rebase-16b",
    );
    writeJsonAtomically(tasksPath, tasks);

    // The conflict was never resolved or aborted, so the rebase is still live in the worktree.
    const reconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-16b", taskNumber, runId: "run-16b", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "ambiguous");
    assert.equal(typeof reconciled.note, "string");
    assert.ok((reconciled.note as string).length > 0);
});

// F3: same branch, but the conflict - and the still-live rebase - sits at the nested submodule
// layer, proving the receipt-before-in-progress ordering per layer, not just at root.
test("test_rebaseTaskWorktree_reconciliationReproducesANestedConflictOutcomeFromTheReceipt", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-17");
    writeFileSync(join(worktreePath, "child", "package.json"), JSON.stringify({ x: "worktree" }));
    git(join(worktreePath, "child"), "add", "package.json");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(rootOrigin, "child", "package.json"), JSON.stringify({ x: "source" }));
    git(join(rootOrigin, "child"), "add", "package.json");
    git(join(rootOrigin, "child"), "commit", "-q", "-m", "child source edit");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink (source)");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-17", stepId: "rebase-17", rootSourceBranch: "main",
    });

    assert.equal(output.conflicted, true);
    assert.equal(output.stoppedAt?.occurrenceId, "child");

    // The conflict was never resolved or aborted, so the rebase is still live in the child checkout.
    const reconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-17", taskNumber, runId: "run-17", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result, output);
});

// F3: a root test-failure outcome (no conflict at all) must also be reconstructable exactly.
test("test_rebaseTaskWorktree_reconciliationReproducesAFailedTestOutcomeFromTheReceipt", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-9");
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ scripts: { test: "false" } }));
    git(worktreePath, "add", "package.json");
    git(worktreePath, "commit", "-q", "-m", "make root tests fail");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-9", stepId: "rebase-9", rootSourceBranch: "main",
    });

    assert.equal(output.conflicted, false);
    assert.equal(output.stoppedAt?.occurrenceId, "");
    assert.notEqual(output.failureReason, null);

    const reconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-9", taskNumber, runId: "run-9", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result, output);
});

// F3: two logical rebase visits in the same run. Before the fix, reconcileRebase only checked
// that `sourceTipsAtRebase` was non-empty and no rebase was in progress - both true after step
// "rebase-A" - so it reported "completed" for a wholly different, never-run step "rebase-B" too.
// It must fail this way pre-fix because input.stepId was never read at all.
test("test_rebaseTaskWorktree_reconciliationRejectsAnOlderStepsReceiptForALaterStep", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-6");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");

    const first = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-6", stepId: "rebase-A", rootSourceBranch: "main",
    });
    assert.equal(first.conflicted, false);

    const staleVisit = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-B", taskNumber, runId: "run-6", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(staleVisit.status, "not-completed");

    // Sanity: the step that actually produced the receipt is still recognized.
    const matchingVisit = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-A", taskNumber, runId: "run-6", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(matchingVisit.status, "completed");
});

// F3: before the fix, reconcileRebase never inspected any worktree HEAD, so a receipt written by
// a finished rebase kept reporting "completed" even after the root worktree moved again.
test("test_rebaseTaskWorktree_reconciliationRejectsAStaleReceiptWhenTheRootHeadMovedSinceTheRebase", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-7");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-7", stepId: "rebase-7", rootSourceBranch: "main",
    });
    assert.equal(output.conflicted, false);

    writeFileSync(join(worktreePath, "after-rebase.txt"), "after\n");
    git(worktreePath, "add", "after-rebase.txt");
    git(worktreePath, "commit", "-q", "-m", "moved after the rebase receipt");

    const reconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-7", taskNumber, runId: "run-7", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "not-completed");
});

// F3: same as above, but the moved HEAD is a nested submodule occurrence, not root - proving the
// per-layer check, not just a root-only one.
test("test_rebaseTaskWorktree_reconciliationRejectsAStaleReceiptWhenANestedOccurrenceHeadMovedSinceTheRebase", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-8");
    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child work");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    const output = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-8", stepId: "rebase-8", rootSourceBranch: "main",
    });
    assert.equal(output.conflicted, false);

    writeFileSync(join(worktreePath, "child", "after-rebase.txt"), "after\n");
    git(join(worktreePath, "child"), "add", "after-rebase.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child moved after the receipt");

    const reconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-8", taskNumber, runId: "run-8", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "not-completed");
});
