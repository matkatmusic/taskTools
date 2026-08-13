// Behavioral checks for scripts/tackle-tasks/reconcileStep.ts. Run: node --test tests/tackle-tasks/reconcileStep.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileStep, type ReconcileStepInput } from "../../scripts/tackle-tasks/reconcileStep.ts";
import { closeTaskRun } from "../../scripts/tackle-tasks/closeTaskRun.ts";
import { cleanupTaskWorktree } from "../../scripts/tackle-tasks/cleanupTaskWorktree.ts";
import { commitTaskWork } from "../../scripts/tackle-tasks/commitTaskWork.ts";
import { createTaskWorktree, taskBranchName } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { writeTaskExitNotes } from "../../scripts/tackle-tasks/writeTaskExitNotes.ts";
import { markTaskInactive } from "../../scripts/tackle-tasks/markTaskInactive.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { claimTask, updateCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup, taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { git, makeCommittedRepo, addSubmodule } from "./support/gitFixtures.ts";

function baseInput(overrides: Partial<ReconcileStepInput>): ReconcileStepInput {
    return {
        script: "", stepId: "step-1", taskNumber: 0, runId: "", projectRoot: "", stepInput: {},
        ...overrides,
    };
}

function writeTasksJson(projectRoot: string, tasks: unknown[]): void {
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
    if (!existsSync(completedTasksPath)) writeFileSync(completedTasksPath, "[]\n");
}

test("test_reconcileStep_recognizesACompletedArchiveAfterALostResult", () => {
    // Setup: a task is claimed, does work, exits completed, and is really archived by closeTaskRun.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-close-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    const claimOutcome = claimTask(1, "run-a", root);
    assert.equal(claimOutcome.status, "claimed");
    updateCurrentTaskRun(1, "run-a", { commits: [{ occurrenceId: "", hash: "abc123", kind: "work" }] }, root);
    writeTaskExitNotes({ taskNumber: 1, runId: "run-a", projectRoot: root, exitType: "completed", exitNote: "done" });
    markTaskInactive({ taskNumber: 1, runId: "run-a", projectRoot: root });
    const realOutput = closeTaskRun({ taskNumber: 1, runId: "run-a", closureNote: "closed", projectRoot: root });
    assert.deepEqual(realOutput.closed, [1]);

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the lost result is reconstructed from the real archive.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result?.closed, [1]);
});

test("test_reconcileStep_reportsNotCompletedForAnArchivePresentInBothTaskFiles", () => {
    // Setup: hand-write the task into BOTH tasks.json and completedTasks.json - the
    // half-finished-archive shape a failure between the two writes would leave.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-both-"));
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeFileSync(tasksPath, `${JSON.stringify([{ taskNumber: 1, title: "t" }], null, 2)}\n`);
    writeFileSync(completedTasksPath, `${JSON.stringify([{
        taskNumber: 1, title: "t", completionDate: "2026-08-01", closureNote: "note", commitHashes: ["abc123"],
    }], null, 2)}\n`);

    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    assert.equal(result.status, "not-completed");
});

test("test_reconcileStep_recognizesAnAlreadyAppliedAmendment", () => {
    // Setup: a plan file whose revision already moved past what the workflow read before the call.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-plan-"));
    const planFilePath = join(root, "plan.json");
    writeFileSync(planFilePath, JSON.stringify({ revision: 3 }));

    // Test action + verification: the applied case is completed with the new revision.
    const applied = reconcileStep(baseInput({
        script: "applyPlanAmendments", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { planFilePath, revisionBefore: 2 },
    }));
    assert.equal(applied.status, "completed");
    assert.equal(applied.result?.revision, 3);

    // Verification: a revisionBefore that already matches the file's revision is not-completed.
    const notApplied = reconcileStep(baseInput({
        script: "applyPlanAmendments", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { planFilePath, revisionBefore: 3 },
    }));
    assert.equal(notApplied.status, "not-completed");
});

test("test_reconcileStep_returnsAStoredTaskTestDecisionWithoutRunningTestsAgain", () => {
    // Setup: a claimed run with a stored taskTests decision for a known stepId. No worktree
    // exists at all here, so nothing could have executed a test process during reconciliation -
    // the decision must come entirely from task.run.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-tests-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    const claimOutcome = claimTask(1, "run-a", root);
    assert.equal(claimOutcome.status, "claimed");
    const storedDecision = {
        stepId: "tests-step-1", testFiles: ["a.test.ts"], createdTestFiles: ["a.test.ts"],
        deletedTestFiles: ["b.test.ts"], missingTests: false, passed: false, output: "1 failing",
        checkedAt: "2026-08-01T00:00:00-07:00",
    };
    updateCurrentTaskRun(1, "run-a", { taskTests: storedDecision }, root);

    const result = reconcileStep(baseInput({
        script: "runTaskTests", stepId: "tests-step-1", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    assert.equal(result.status, "completed");
    assert.equal(result.result?.passed, false);
    assert.deepEqual(result.result?.deletedTestFiles, ["b.test.ts"]);
});

test("test_reconcileStep_recognizesACreatedWorktreeAndAdoptedLease", () => {
    // Setup: a real repo with a real submodule, a claimed run, and a real created worktree.
    const childOrigin = makeCommittedRepo("reconcileStep-create-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-create-root-", "main");
    addSubmodule(root, childOrigin, "vendor");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    const claimOutcome = claimTask(1, "run-a", root);
    assert.equal(claimOutcome.status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "createTaskWorktree", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the created worktree and branch are reconstructed.
    assert.equal(result.status, "completed");
    assert.equal(result.result?.worktree, created.worktree);
    assert.equal(result.result?.branch, created.branch);

    // Verification: a lease naming a different run is not-completed, even under the original runId.
    writeFileSync(taskWorktreeLeasePath(created.worktree), JSON.stringify({ runId: "run-other", pid: 1, createdAt: 1 }));
    const mismatched = reconcileStep(baseInput({
        script: "createTaskWorktree", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));
    assert.equal(mismatched.status, "not-completed");
});

test("test_reconcileStep_recognizesALandedMergeFromItsPersistenceRef", () => {
    // Setup: a real linked worktree with a real submodule occurrence, but no real rebase/merge -
    // instead the persistence refs a landed merge would have left are set directly with a real
    // `git update-ref`, in every source occurrence (root and submodule).
    const childOrigin = makeCommittedRepo("reconcileStep-merge-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-merge-root-", "main");
    addSubmodule(root, childOrigin, "child");
    const groupId = 900_001;
    const worktreePath = createWorktreeForGroup(root, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, "run-a");
    const branch = taskBranchName(groupId);
    git(root, "update-ref", `refs/taskTools/merged-commits/${branch}`, git(root, "rev-parse", "HEAD"));
    git(join(root, "child"), "update-ref", `refs/taskTools/merged-commits/${branch}`, git(join(root, "child"), "rev-parse", "HEAD"));

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "mergeTaskWorktree", taskNumber: groupId, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath },
    }));

    // Verification: one merge-kind commit per source occurrence, root and submodule.
    assert.equal(result.status, "completed");
    assert.equal(result.result?.merged, true);
    const commits = result.result?.commits as { occurrenceId: string; kind: string }[];
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map((commit) => commit.kind), ["merge", "merge"]);
    assert.deepEqual(commits.map((commit) => commit.occurrenceId).sort(), ["", "child"]);
});

test("test_reconcileStep_recognizesACompletedCleanup", () => {
    // Setup: a real linked worktree with a real submodule, cleaned up for real - acquiring the
    // source lock first, exactly like cleanupTaskWorktree.test.ts does.
    const childOrigin = makeCommittedRepo("reconcileStep-cleanup-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-cleanup-root-", "main");
    addSubmodule(root, childOrigin, "child");
    const groupId = 900_002;
    const worktreePath = createWorktreeForGroup(root, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, "run-a");
    const owner = buildLockOwner("run-a", groupId);
    assert.equal(acquireSourceRepoLock(root, owner).status, "acquired");
    const realOutput = cleanupTaskWorktree({ projectRoot: root, worktreePath, taskNumber: groupId, runId: "run-a" });
    assert.equal(realOutput.removed, true);

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "cleanupTaskWorktree", taskNumber: groupId, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath },
    }));

    // Verification: the real, already-complete cleanup is recognized, nothing retained.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result?.retainedArtifacts, []);
});

test("test_reconcileStep_reportsAmbiguousRatherThanGuessing", () => {
    // Setup: a claimed run whose modifiedFiles record is empty, and whose worktree is gone -
    // the two facts that alone cannot distinguish "nothing ever changed" from "clean-up erased
    // the evidence".
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-ambiguous-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    const claimOutcome = claimTask(1, "run-a", root);
    assert.equal(claimOutcome.status, "claimed");
    const deletedWorktreePath = join(root, "does-not-exist", "task-1");

    const result = reconcileStep(baseInput({
        script: "recordTaskModifiedFiles", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktree: deletedWorktreePath, sourceBranch: "main" },
    }));

    assert.equal(result.status, "ambiguous");
    assert.notEqual(result.note, null);
});

test("test_reconcileStep_reconstructsTheInitSubmodulesValueTheRealBoxWouldHavePrinted", () => {
    // Case A: no .gitmodules at all - the real box reports initialized:false unconditionally.
    const noSubmodules = makeCommittedRepo("reconcileStep-init-nosub-");
    const resultA = reconcileStep(baseInput({
        script: "initTaskSubmodules", taskNumber: 1, runId: "run-a", projectRoot: noSubmodules,
        stepInput: { worktreePath: noSubmodules },
    }));
    assert.equal(resultA.status, "completed");
    assert.equal(resultA.result?.initialized, false);

    // Case B: a real submodule that is already populated (git submodule add checks it out) -
    // the real box also reports initialized:false here, since it had nothing left to populate.
    const childOrigin = makeCommittedRepo("reconcileStep-init-child-", "child-main");
    const withSubmodule = makeCommittedRepo("reconcileStep-init-root-", "main");
    addSubmodule(withSubmodule, childOrigin, "child");
    const resultB = reconcileStep(baseInput({
        script: "initTaskSubmodules", taskNumber: 1, runId: "run-a", projectRoot: withSubmodule,
        stepInput: { worktreePath: withSubmodule },
    }));
    assert.equal(resultB.status, "completed");
    assert.equal(resultB.result?.initialized, false);
});

test("test_reconcileStep_reportsNotCompletedWhenCleanupLeftArtifactsInsideASubmodule", () => {
    // Setup: a real source repo with a real submodule and a real linked worktree, cleaned up for
    // real so the ROOT looks finished (no worktree, no root refs, no lease).
    const childOrigin = makeCommittedRepo("reconcileStep-cleanup-leak-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-cleanup-leak-root-", "main");
    addSubmodule(root, childOrigin, "child");
    const groupId = 900_003;
    const worktreePath = createWorktreeForGroup(root, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, "run-a");
    const owner = buildLockOwner("run-a", groupId);
    assert.equal(acquireSourceRepoLock(root, owner).status, "acquired");
    const realOutput = cleanupTaskWorktree({ projectRoot: root, worktreePath, taskNumber: groupId, runId: "run-a" });
    assert.equal(realOutput.removed, true);

    // Plant a persistence ref directly in the SUBMODULE's own source checkout - the layer a
    // handler that only inspects input.projectRoot (the root) can never see.
    const branch = taskBranchName(groupId);
    git(join(root, "child"), "update-ref", `refs/taskTools/merge-intents/${branch}`, git(join(root, "child"), "rev-parse", "HEAD"));

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "cleanupTaskWorktree", taskNumber: groupId, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath },
    }));

    // Verification: the leaked submodule ref is caught, not silently reported completed.
    assert.equal(result.status, "not-completed");
    assert.match(result.note ?? "", /child/);
});

test("test_reconcileStep_recognizesACompletedCommitWhenOneLayerHadNothingToCommit", () => {
    // Setup: a real linked worktree with a real submodule, created through the real pipeline.
    const childOrigin = makeCommittedRepo("reconcileStep-commit-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-commit-root-", "main");
    addSubmodule(root, childOrigin, "child");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    const claimOutcome = claimTask(1, "run-a", root);
    assert.equal(claimOutcome.status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);

    // Dirty ONLY the root layer. The submodule stays clean, so the real commitTaskWork skips it
    // and appends no record entry for it - a legitimate, fewer-entries-than-occurrences result.
    writeFileSync(join(created.worktree, "root-only.txt"), "root change\n");
    const commitOutput = commitTaskWork({
        projectRoot: root, worktreePath: created.worktree, taskNumber: 1, runId: "run-a", rootSourceBranch: "main",
    });
    assert.equal(commitOutput.commits.length, 1);
    assert.equal(commitOutput.commits[0].occurrenceId, "");

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "commitTaskWork", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath: created.worktree, rootSourceBranch: "main" },
    }));

    // Verification: completed, with exactly the root commit - no demand for a submodule entry.
    assert.equal(result.status, "completed");
    const commits = result.result?.commits as { occurrenceId: string }[];
    assert.equal(commits.length, 1);
    assert.equal(commits[0].occurrenceId, "");

    // Verification: the genuine incomplete case still reports not-completed - dirty a layer and
    // reconcile without committing.
    writeFileSync(join(created.worktree, "root-only-2.txt"), "another root change\n");
    const incomplete = reconcileStep(baseInput({
        script: "commitTaskWork", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath: created.worktree, rootSourceBranch: "main" },
    }));
    assert.equal(incomplete.status, "not-completed");
});

test("test_reconcileStep_refusesToReconcileAReadOnlyBox", () => {
    // Setup: a read-only box has nothing for reconciliation to reconstruct - asking for one is a
    // workflow bug, not a verdict.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-readonly-"));

    assert.throws(() => reconcileStep(baseInput({
        script: "isTaskOpen", taskNumber: 1, runId: "run-a", projectRoot: root,
    })));
});
