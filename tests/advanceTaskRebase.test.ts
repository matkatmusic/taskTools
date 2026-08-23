// Behavioral checks for scripts/tackle-tasks/advanceTaskRebase.ts. Run: node --test tests/tackle-tasks/advanceTaskRebase.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTaskRebase } from "../../scripts/tackle-tasks/advanceTaskRebase.ts";
import { rebaseTaskWorktree } from "../../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { reconcileStep } from "../../scripts/tackle-tasks/reconcileStep.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { rebaseInProgress } from "../../scripts/mergeTaskWorktrees.ts";
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

function makeTempRepoWithTestScript(branchName: string): string {
    const repoPath = tmpMkdir("advance-rebase-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    writeFileSync(join(repoPath, "shared.txt"), "base\n");
    git(repoPath, "add", "shared.txt");
    git(repoPath, "commit", "-q", "-m", "add shared.txt");
    return repoPath;
}

// F1: rootOriginChildPath is the real source child checkout - the local, possibly-unpushed
// authority the rebase now fetches from. It is distinct from the worktree's own child checkout.
function makeSourceRepoWithSubmodule(): { rootOrigin: string; childOrigin: string; rootOriginChildPath: string } {
    const childOrigin = makeTempRepoWithTestScript("child-main");
    const rootOrigin = makeTempRepoWithTestScript("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return { rootOrigin, childOrigin, rootOriginChildPath: join(rootOrigin, "child") };
}

let nextGroupId = 1;
// operationBranch is attached as "task-<taskNumber>" by the scripts under test, so taskNumber
// here must equal the worktree's real groupId - matching production's one-task-per-group.
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

// Independently commits in the source's child checkout, never in the worktree's own child
// clone - simulating the source repository advancing while the task worktree exists.
function advanceSourceChildBranch(rootOrigin: string, rootOriginChildPath: string, content: string): void {
    writeFileSync(join(rootOriginChildPath, "shared.txt"), content);
    git(rootOriginChildPath, "add", "shared.txt");
    git(rootOriginChildPath, "commit", "-q", "-m", "advance source child");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink");
}

test("test_advanceTaskRebase_distinguishesTheRootAndASubmoduleWithTheSameConflictPath", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-10");
    const childCheckoutPath = join(worktreePath, "child");

    // Worktree edits both layers' shared.txt.
    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(worktreePath, "shared.txt"), "root-worktree\n");
    git(worktreePath, "add", "shared.txt");
    git(worktreePath, "commit", "-q", "-m", "root worktree edit");

    // Source moves both layers' shared.txt too, guaranteeing a conflict in each.
    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");
    writeFileSync(join(rootOrigin, "shared.txt"), "root-source\n");
    git(rootOrigin, "add", "shared.txt");
    git(rootOrigin, "commit", "-q", "-m", "root source edit");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-10", stepId: "rebase-10", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");
    assert.deepEqual(first.conflictedFilePaths, ["shared.txt"]);

    // F3: rebaseTaskWorktree's NESTED conflict result is reconstructable exactly.
    const firstReconciled = reconcileStep({
        script: "rebaseTaskWorktree", stepId: "rebase-10", taskNumber, runId: "run-10", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(firstReconciled.status, "completed");
    assert.deepEqual(firstReconciled.result, first);

    // Resolve the submodule conflict and stage it, without running --continue ourselves.
    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, false);
    assert.equal(second.conflicted, true);
    assert.equal(second.stoppedAt?.occurrenceId, "");
    assert.notEqual(second.stoppedAt?.occurrenceId, first.stoppedAt?.occurrenceId);
    assert.deepEqual(second.conflictedFilePaths, ["shared.txt"]);

    // F3: advanceTaskRebase's ROOT conflict result (the same stepId, a later visit) is also
    // reconstructable exactly, and supersedes the earlier nested-conflict receipt for that stepId.
    const secondReconciled = reconcileStep({
        script: "advanceTaskRebase", stepId: "rebase-10", taskNumber, runId: "run-10", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(secondReconciled.status, "completed");
    assert.deepEqual(secondReconciled.result, second);
});

test("test_advanceTaskRebase_reportsFinishedOnlyWhenNoLayerHasARebaseInProgress", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-11");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-11", stepId: "rebase-11", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stoppedAt: first.stoppedAt! });

    assert.equal(second.finished, true);
    assert.equal(second.conflicted, false);
    assert.equal(second.stoppedAt, null);
    assert.equal(rebaseInProgress(childCheckoutPath), false);
    assert.equal(rebaseInProgress(worktreePath), false);

    // F3: the finished rebase persisted its source-tip receipt.
    const run = getCurrentTaskRun(taskNumber, rootOrigin) as { sourceTipsAtRebase?: { occurrenceId: string; baseBranch: string; sourceTip: string }[] } | null;
    assert.deepEqual(run?.sourceTipsAtRebase?.map((receipt) => receipt.occurrenceId).sort(), ["", "child"]);
});

// F3: a test-failure outcome from advanceTaskRebase (root layer, no conflict) is also
// reconstructable exactly from its receipt.
test("test_advanceTaskRebase_reconciliationReproducesAFailedTestOutcomeFromTheReceipt", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-15");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    // Make the root's own test script fail, so once the submodule conflict resolves and
    // advanceTaskRebase reaches the root layer, its test step (not a conflict) fails.
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ scripts: { test: "false" } }));
    git(worktreePath, "add", "package.json");
    git(worktreePath, "commit", "-q", "-m", "make root tests fail");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-15", stepId: "rebase-15", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stepId: "advance-15", stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, false);
    assert.equal(second.conflicted, false);
    assert.equal(second.stoppedAt?.occurrenceId, "");
    assert.notEqual(second.failureReason, null);

    const reconciled = reconcileStep({
        script: "advanceTaskRebase", stepId: "advance-15", taskNumber, runId: "run-15", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result, second);
});

// F3: a fresh conflict raised BY advanceTaskRebase's own --continue (a second worktree commit in
// the same nested layer) must be reconstructable exactly while that layer's rebase is still live.
test("test_advanceTaskRebase_reconciliationReproducesANestedConflictOutcomeFromTheReceipt", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-18");
    const childCheckoutPath = join(worktreePath, "child");

    // Two local child commits, so the second --continue can hit a fresh conflict of its own.
    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree-1\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit 1");
    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree-2\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit 2");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-18", stepId: "rebase-18", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    // Resolve only the first commit's conflict.
    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved-1\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stepId: "advance-18", stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, false);
    assert.equal(second.conflicted, true);
    assert.equal(second.stoppedAt?.occurrenceId, "child");
    assert.deepEqual(second.conflictedFilePaths, ["shared.txt"]);

    // The second conflict was never resolved or aborted, so the child rebase is still live.
    const reconciled = reconcileStep({
        script: "advanceTaskRebase", stepId: "advance-18", taskNumber, runId: "run-18", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result, second);
});

// No receipt plus a live rebase is undecidable, so reconciliation must never authorise a rerun.
test("test_advanceTaskRebase_reportsAmbiguousForALiveConflictWhoseReceiptWasNeverAppended", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-20");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree-1\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit 1");
    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree-2\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit 2");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-20", stepId: "rebase-20", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved-1\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stepId: "advance-20", stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, false);
    assert.equal(second.conflicted, true);

    // Simulate the process dying before persistRebaseStepResult() appended the receipt: the
    // live conflict on disk is real, but nothing on record says it happened.
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as Array<{ taskNumber: number; run: { history: Array<{ stepResults?: Array<{ stepId: string }> }> } }>;
    const task = tasks.find((entry) => entry.taskNumber === taskNumber)!;
    const currentRun = task.run.history[task.run.history.length - 1];
    currentRun.stepResults = (currentRun.stepResults ?? []).filter((entry) => entry.stepId !== "advance-20");
    writeJsonAtomically(tasksPath, tasks);

    const reconciled = reconcileStep({
        script: "advanceTaskRebase", stepId: "advance-20", taskNumber, runId: "run-20", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "ambiguous");
    assert.equal(typeof reconciled.note, "string");
    assert.ok(reconciled.note && reconciled.note.length > 0);
});

// F3: a root conflict raised BY advanceTaskRebase's own layer walk (after the nested layer
// finished) must be reconstructable exactly while the root rebase is still live.
test("test_advanceTaskRebase_reconciliationReproducesARootConflictOutcomeFromTheReceipt", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-19");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(worktreePath, "shared.txt"), "root-worktree\n");
    git(worktreePath, "add", "shared.txt");
    git(worktreePath, "commit", "-q", "-m", "root worktree edit");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");
    writeFileSync(join(rootOrigin, "shared.txt"), "root-source\n");
    git(rootOrigin, "add", "shared.txt");
    git(rootOrigin, "commit", "-q", "-m", "root source edit");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-19", stepId: "rebase-19", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stepId: "advance-19", stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, false);
    assert.equal(second.conflicted, true);
    assert.equal(second.stoppedAt?.occurrenceId, "");
    assert.deepEqual(second.conflictedFilePaths, ["shared.txt"]);

    // The root conflict was never resolved or aborted, so the root rebase is still live.
    const reconciled = reconcileStep({
        script: "advanceTaskRebase", stepId: "advance-19", taskNumber, runId: "run-19", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result, second);
});

test("test_advanceTaskRebase_refusesAndMutatesNothingWhenTheLockIsHeldByAnotherRun", () => {
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-20");
    acquireSourceRepoLock(rootOrigin, buildLockOwner("other-run", taskNumber));
    const beforeHead = git(worktreePath, "rev-parse", "HEAD");

    assert.throws(() => advanceTaskRebase({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-20", stepId: "rebase-20", rootSourceBranch: "main",
        stoppedAt: { occurrenceId: "", checkoutPath: worktreePath },
    }));

    assert.equal(git(worktreePath, "rev-parse", "HEAD"), beforeHead);
    assert.equal(rebaseInProgress(worktreePath), false);
    const run = getCurrentTaskRun(taskNumber, rootOrigin) as { sourceTipsAtRebase?: unknown } | null;
    assert.equal(run?.sourceTipsAtRebase, undefined);
});

// F3: before the fix, reconcileRebase never inspected any worktree HEAD, so a receipt written by
// a finished advance kept reporting "completed" even after the root worktree moved again.
test("test_advanceTaskRebase_reconciliationRejectsAStaleReceiptWhenTheRootHeadMovedSinceItFinished", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-13");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-13", stepId: "advance-13", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");
    const second = advanceTaskRebase({ ...rebaseInput, stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, true);

    writeFileSync(join(worktreePath, "after-advance.txt"), "after\n");
    git(worktreePath, "add", "after-advance.txt");
    git(worktreePath, "commit", "-q", "-m", "moved after the advance receipt");

    const reconciled = reconcileStep({
        script: "advanceTaskRebase", stepId: "advance-13", taskNumber, runId: "run-13", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "not-completed");
});

// F3: same as above, but the moved HEAD is a nested submodule occurrence, not root.
test("test_advanceTaskRebase_reconciliationRejectsAStaleReceiptWhenANestedOccurrenceHeadMovedSinceItFinished", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-14");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-14", stepId: "advance-14", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");
    const second = advanceTaskRebase({ ...rebaseInput, stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, true);

    writeFileSync(join(childCheckoutPath, "after-advance.txt"), "after\n");
    git(childCheckoutPath, "add", "after-advance.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child moved after the advance receipt");

    const reconciled = reconcileStep({
        script: "advanceTaskRebase", stepId: "advance-14", taskNumber, runId: "run-14", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "not-completed");
});
