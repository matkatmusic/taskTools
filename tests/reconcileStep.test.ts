// Behavioral checks for scripts/tackle-tasks/reconcileStep.ts. Run: node --test tests/tackle-tasks/reconcileStep.test.ts
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileStep, type ReconcileStepInput } from "../../scripts/tackle-tasks/reconcileStep.ts";
import { getMutatingWorkflowScripts } from "../../scripts/tackle-tasks/greenBoxPolicy.ts";
import { closeTaskRun } from "../../scripts/tackle-tasks/closeTaskRun.ts";
import { cleanupTaskWorktree } from "../../scripts/tackle-tasks/cleanupTaskWorktree.ts";
import { commitTaskWork } from "../../scripts/tackle-tasks/commitTaskWork.ts";
import { createTaskWorktree, taskBranchName, taskWorktreeCreateJournalPath } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { resetTaskWorktree } from "../../scripts/tackle-tasks/resetTaskWorktree.ts";
import { isTaskActive } from "../../scripts/tackle-tasks/isTaskActive.ts";
import { generateTaskDocs } from "../../scripts/tackle-tasks/generateTaskDocs.ts";
import { updateTaskDocs } from "../../scripts/tackle-tasks/updateTaskDocs.ts";
import { runFullSuite } from "../../scripts/tackle-tasks/runFullSuite.ts";
import { rebaseTaskWorktree } from "../../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { advanceTaskRebase } from "../../scripts/tackle-tasks/advanceTaskRebase.ts";
import { recordMergeCommits } from "../../scripts/tackle-tasks/recordMergeCommits.ts";
import { recordTaskModifiedFiles } from "../../scripts/tackle-tasks/recordTaskModifiedFiles.ts";
import { releaseTaskRunHolds } from "../../scripts/tackle-tasks/releaseTaskRunHolds.ts";
import { writeTaskExitNotes } from "../../scripts/tackle-tasks/writeTaskExitNotes.ts";
import { markTaskInactive } from "../../scripts/tackle-tasks/markTaskInactive.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { initTaskSubmodules } from "../../scripts/tackle-tasks/initTaskSubmodules.ts";
import { isTaskRunResumable } from "../../scripts/tackle-tasks/isTaskRunResumable.ts";
import { amendEntryWithCodexNotes } from "../../scripts/tackle-tasks/amendEntryWithCodexNotes.ts";
import { amendEntryWithFailingTests } from "../../scripts/tackle-tasks/amendEntryWithFailingTests.ts";
import { recordPlanReview } from "../../scripts/tackle-tasks/recordPlanReview.ts";
import { claimTask, readTaskRunState, updateCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup, taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { git, makeCommittedRepo, addSubmodule } from "./support/gitFixtures.ts";

// Every test in this file registers itself here, so the coverage assertion below checks against real test names it can see were actually declared - not a hand-copied list that can go stale.
const registeredCaseNames = new Set<string>();
function test(name: string, fn: () => void | Promise<void>): void {
    registeredCaseNames.add(name);
    nodeTest(name, fn);
}

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

// Builds a real ended, completed run under `runId` (via the same production functions the workflow uses) and returns the durable `run` state an archived record retains it under.
function buildEndedCompletedRun(root: string, taskNumber: number, runId: string, hash: string) {
    writeTasksJson(root, [{ taskNumber, title: "t" }]);
    assert.equal(claimTask(taskNumber, runId, root).status, "claimed");
    updateCurrentTaskRun(taskNumber, runId, { commits: [{ occurrenceId: "", hash, kind: "work" }] }, root);
    writeTaskExitNotes({ taskNumber, runId, projectRoot: root, exitType: "completed", exitNote: "done" });
    markTaskInactive({ taskNumber, runId, projectRoot: root });
    return readTaskRunState(taskNumber, root);
}

function writeArchivedOnly(root: string, archived: Record<string, unknown>): void {
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    writeFileSync(tasksPath, "[]\n");
    writeFileSync(completedTasksPath, `${JSON.stringify([archived], null, 2)}\n`);
}

test("test_reconcileStep_recognizesACompletedArchiveAfterALostResult", () => {
    // Setup: a task is claimed, does work, exits completed, and is really archived by closeTaskRun.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-close-"));
    buildEndedCompletedRun(root, 1, "run-a", "abc123");
    const realOutput = closeTaskRun({ taskNumber: 1, runId: "run-a", closureNote: "closed", projectRoot: root, stepId: "step-1" });
    assert.deepEqual(realOutput.closed, [1]);

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { closureNote: "closed" },
    }));

    // Verification: the lost result is reconstructed from the real archive's receipt.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);
});

test("test_reconcileStep_reportsNotCompletedForAnArchivePresentInBothTaskFiles", () => {
    // Setup: hand-write the task into BOTH tasks.json and completedTasks.json - the half-finished-archive shape a failure between the two writes would leave. The archived record retains run-a's own ended, completed run.history entry, so this is provably the SAME run's durable record, not merely a same-numbered task.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-both-"));
    const state = buildEndedCompletedRun(root, 1, "run-a", "abc123");
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    writeFileSync(tasksPath, `${JSON.stringify([{ taskNumber: 1, title: "t" }], null, 2)}\n`);
    writeFileSync(completedTasksPath, `${JSON.stringify([{
        taskNumber: 1, title: "t", completionDate: "2026-08-01", closureNote: "note",
        commitHashes: ["abc123"], run: state,
    }], null, 2)}\n`);

    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { closureNote: "note" },
    }));

    assert.equal(result.status, "not-completed");
});

// Before the [a4 4] fix, readStateOrNull() always returned null once a task was archived (it only reads tasks.json), so `expected` was always null, the commit comparison was skipped entirely, and ANY archive with the same task number reported "completed" regardless of which run produced it. This test fails against that old behavior because run-b's archive would be reported completed for run-a.
test("test_reconcileStep_reportsAmbiguousForACompletedOnlyArchiveFromTheWrongRun", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-close-wrongrun-"));
    const state = buildEndedCompletedRun(root, 1, "run-b", "abc123");
    writeArchivedOnly(root, {
        taskNumber: 1, title: "t", completionDate: "2026-08-01", closureNote: "closed",
        commitHashes: ["abc123"], run: state,
    });

    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { closureNote: "closed" },
    }));

    assert.equal(result.status, "ambiguous");
});

// Before the fix, the archive's closureNote was never read at all - only presence/absence and (for completed-only, via a different code path) hashes mattered. This test fails against that old behavior because a mismatched note would still report "completed".
test("test_reconcileStep_reportsAmbiguousForACompletedOnlyArchiveWithTheWrongClosureNote", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-close-wrongnote-"));
    const state = buildEndedCompletedRun(root, 1, "run-a", "abc123");
    writeArchivedOnly(root, {
        taskNumber: 1, title: "t", completionDate: "2026-08-01", closureNote: "the actual note",
        commitHashes: ["abc123"], run: state,
    });

    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { closureNote: "a different note" },
    }));

    assert.equal(result.status, "ambiguous");
});

// Before the fix, `expected` came from readStateOrNull() (always null post-archive) rather than the archive's own retained hashes, so a wrong-hash archive was also reported "completed". This test fails against that old behavior for the same reason.
test("test_reconcileStep_reportsAmbiguousForACompletedOnlyArchiveWithTheWrongCommitHashes", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-close-wronghash-"));
    const state = buildEndedCompletedRun(root, 1, "run-a", "abc123");
    writeArchivedOnly(root, {
        taskNumber: 1, title: "t", completionDate: "2026-08-01", closureNote: "closed",
        commitHashes: ["not-the-recorded-hash"], run: state,
    });

    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { closureNote: "closed" },
    }));

    assert.equal(result.status, "ambiguous");
});

// Before the fix, the both-files path returned "not-completed" purely from tasks.json/ completedTasks.json presence, without ever proving the archive belongs to THIS run. This test fails against that old behavior because a different run's same-numbered archive would still be reported "not-completed" (telling the workflow a safe rerun exists) instead of "ambiguous".
test("test_reconcileStep_reportsAmbiguousForABothFilesArchiveFromTheWrongRun", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-both-wrongrun-"));
    const state = buildEndedCompletedRun(root, 1, "run-b", "abc123");
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    writeFileSync(tasksPath, `${JSON.stringify([{ taskNumber: 1, title: "t" }], null, 2)}\n`);
    writeFileSync(completedTasksPath, `${JSON.stringify([{
        taskNumber: 1, title: "t", completionDate: "2026-08-01", closureNote: "closed",
        commitHashes: ["abc123"], run: state,
    }], null, 2)}\n`);

    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { closureNote: "closed" },
    }));

    assert.equal(result.status, "ambiguous");
});

// A malformed archive (commitHashes not even an array) must never be treated as proof of anything, regardless of run/note. This fails against the old behavior, which never validated shape for the completed-only path at all.
test("test_reconcileStep_reportsAmbiguousForAMalformedCompletedOnlyArchive", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-close-malformed-"));
    const state = buildEndedCompletedRun(root, 1, "run-a", "abc123");
    writeArchivedOnly(root, {
        taskNumber: 1, title: "t", completionDate: "2026-08-01", closureNote: "closed",
        commitHashes: "not-an-array", run: state,
    });

    const result = reconcileStep(baseInput({
        script: "closeTaskRun", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { closureNote: "closed" },
    }));

    assert.equal(result.status, "ambiguous");
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
    // Setup: a claimed run with a stored taskTests decision for a known stepId. No worktree exists at all here, so nothing could have executed a test process during reconciliation - the decision must come entirely from task.run.
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
    // Setup: a real linked worktree with a real submodule occurrence, but no real rebase/merge - instead the persistence refs a landed merge would have left are set directly with a real `git update-ref`, in every source occurrence (root and submodule).
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
    // Setup: a real linked worktree with a real submodule, cleaned up for real - acquiring the source lock first, exactly like cleanupTaskWorktree.test.ts does.
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
    // Setup: a claimed run whose modifiedFiles record is empty, and whose worktree is gone - the two facts that alone cannot distinguish "nothing ever changed" from "clean-up erased the evidence".
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

// F10: `initialized` is reconstructed only from a durable receipt the real box wrote - never guessed from live submodule status. Both reachable booleans are covered.
test("test_reconcileStep_reconstructsInitSubmodulesReceiptForBothInitializedStates", () => {
    // Case A: no .gitmodules at all - the real box reports initialized:false unconditionally.
    const noSubmodules = makeCommittedRepo("reconcileStep-init-nosub-");
    writeTasksJson(noSubmodules, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", noSubmodules).status, "claimed");
    const realOutputA = initTaskSubmodules({
        worktreePath: noSubmodules, taskNumber: 1, runId: "run-a", projectRoot: noSubmodules, stepId: "step-a",
    });
    assert.equal(realOutputA.initialized, false);
    const resultA = reconcileStep(baseInput({
        script: "initTaskSubmodules", stepId: "step-a", taskNumber: 1, runId: "run-a", projectRoot: noSubmodules,
        stepInput: { worktreePath: noSubmodules },
    }));
    assert.equal(resultA.status, "completed");
    assert.deepEqual(resultA.result, realOutputA);

    // Case B: a deinitialized submodule that this call actually populates.
    const childOrigin = makeCommittedRepo("reconcileStep-init-child-", "child-main");
    const withSubmodule = makeCommittedRepo("reconcileStep-init-root-", "main");
    addSubmodule(withSubmodule, childOrigin, "child");
    git(withSubmodule, "submodule", "deinit", "-f", "child");
    writeTasksJson(withSubmodule, [{ taskNumber: 2, title: "t" }]);
    assert.equal(claimTask(2, "run-b", withSubmodule).status, "claimed");
    const realOutputB = initTaskSubmodules({
        worktreePath: withSubmodule, taskNumber: 2, runId: "run-b", projectRoot: withSubmodule, stepId: "step-b",
    });
    assert.equal(realOutputB.initialized, true);
    const resultB = reconcileStep(baseInput({
        script: "initTaskSubmodules", stepId: "step-b", taskNumber: 2, runId: "run-b", projectRoot: withSubmodule,
        stepInput: { worktreePath: withSubmodule },
    }));
    assert.equal(resultB.status, "completed");
    assert.deepEqual(resultB.result, realOutputB);
});

test("test_reconcileStep_reportsNotCompletedWhenCleanupLeftArtifactsInsideASubmodule", () => {
    // Setup: a real source repo with a real submodule and a real linked worktree, cleaned up for real so the ROOT looks finished (no worktree, no root refs, no lease).
    const childOrigin = makeCommittedRepo("reconcileStep-cleanup-leak-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-cleanup-leak-root-", "main");
    addSubmodule(root, childOrigin, "child");
    const groupId = 900_003;
    const worktreePath = createWorktreeForGroup(root, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, "run-a");
    const owner = buildLockOwner("run-a", groupId);
    assert.equal(acquireSourceRepoLock(root, owner).status, "acquired");
    const realOutput = cleanupTaskWorktree({ projectRoot: root, worktreePath, taskNumber: groupId, runId: "run-a" });
    assert.equal(realOutput.removed, true);

    // Plant a persistence ref directly in the SUBMODULE's own source checkout - the layer a handler that only inspects input.projectRoot (the root) can never see.
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

    // Dirty ONLY the root layer. The submodule stays clean, so the real commitTaskWork skips it and appends no record entry for it - a legitimate, fewer-entries-than-occurrences result.
    writeFileSync(join(created.worktree, "root-only.txt"), "root change\n");
    const commitOutput = commitTaskWork({
        projectRoot: root, worktreePath: created.worktree, taskNumber: 1, runId: "run-a",
        stepId: "step-1", rootSourceBranch: "main",
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

    // Verification: the genuine incomplete case still reports not-completed - dirty a layer and reconcile without committing.
    writeFileSync(join(created.worktree, "root-only-2.txt"), "another root change\n");
    const incomplete = reconcileStep(baseInput({
        script: "commitTaskWork", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath: created.worktree, rootSourceBranch: "main" },
    }));
    assert.equal(incomplete.status, "not-completed");
});

// Before the fix, a recorded commit with no stepId at all (the legacy shape a commit made before F2 fencing existed would have) matched ANY requested step. This test fails against that old behavior: it would report "completed" for stepId "step-current" even though no commit in the record actually carries it.
test("test_reconcileStep_doesNotCompleteAStepFromACommitRecordedWithNoStepId", () => {
    const root = makeCommittedRepo("reconcileStep-commit-nostepid-", "main");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);
    updateCurrentTaskRun(1, "run-a", {
        commits: [{ occurrenceId: "", hash: git(created.worktree, "rev-parse", "HEAD"), kind: "work" }],
    }, root);

    const result = reconcileStep(baseInput({
        script: "commitTaskWork", taskNumber: 1, runId: "run-a", projectRoot: root, stepId: "step-current",
        stepInput: { worktreePath: created.worktree, rootSourceBranch: "main" },
    }));

    assert.equal(result.status, "not-completed");
    assert.match(result.note ?? "", /step-current/);
});

test("test_reconcileStep_refusesToReconcileAReadOnlyBox", () => {
    // Setup: a read-only box has nothing for reconciliation to reconstruct - asking for one is a workflow bug, not a verdict.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-readonly-"));

    assert.throws(() => reconcileStep(baseInput({
        script: "isTaskOpen", taskNumber: 1, runId: "run-a", projectRoot: root,
    })));
});

// F1: the read-only classifier must not guess "not-completed" (safe to blindly rerun) when a retained creation journal disagrees with the live physical lease - a rerun of createTaskWorktree would refuse in that case, so blindly retrying is not actually safe.
test("test_reconcileStep_reportsAmbiguousWhenACreateJournalNamesAnOwnerTheLeaseNoLongerMatches", () => {
    // Setup: a real, completed creation under run-a, then a journal is hand-written back (a retained journal from an earlier attempt), and the physical lease is separately overwritten to name a live third run. Before the fix, reconcileCreateTaskWorktree never looked at the journal at all: it would see task state still says leaseRunId "run-a" (untouched) and the worktree is still structurally fine, and would incorrectly report "not-completed" - telling the workflow a blind rerun is safe when it is not.
    const childOrigin = makeCommittedRepo("reconcileStep-journal-conflict-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-journal-conflict-root-", "main");
    addSubmodule(root, childOrigin, "vendor");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    claimTask(1, "run-a", root);
    const created = createTaskWorktree(1, "run-a", root);
    const journalPath = taskWorktreeCreateJournalPath(created.worktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: created.worktree, branch: created.branch,
        createdAt: "2026-01-01T00:00:00+00:00",
    }));
    writeFileSync(taskWorktreeLeasePath(created.worktree), JSON.stringify({ runId: "run-c", pid: 1, createdAt: 1 }));

    // Test action: reconcile with the retained journal now disagreeing with the live lease.
    const result = reconcileStep(baseInput({
        script: "createTaskWorktree", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: not guessed as safely rerunnable - ambiguous, and nothing touched.
    assert.equal(result.status, "ambiguous");
    assert.ok(existsSync(created.worktree));
    assert.ok(existsSync(journalPath));
});

// Remediation for phase8-9-audit finding 1 / feedback-phase8-1 finding 1: the classifier never compared the retained journal's runId with the requested runId, so a reconcile call for run B could report a completed journal owned by run A as "completed" for run B. Before the fix this test's assert.equal(status, "ambiguous") would fail: it would report "completed" and hand back run-a's worktree/branch to a reconciliation call made on behalf of run-b.
test("test_reconcileStep_reportsAmbiguousRatherThanCompletingAnotherRunsRetainedCreateJournal", () => {
    // Setup: task 1's creation genuinely completed under run-a, then a journal is hand-written back to simulate death right before its own unlink - a completed retained journal for run-a.
    const childOrigin = makeCommittedRepo("reconcileStep-journal-otherrun-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-journal-otherrun-root-", "main");
    addSubmodule(root, childOrigin, "vendor");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    claimTask(1, "run-a", root);
    const created = createTaskWorktree(1, "run-a", root);
    const journalPath = taskWorktreeCreateJournalPath(created.worktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: created.worktree, branch: created.branch,
        createdAt: "2026-01-01T00:00:00+00:00",
    }));

    // Test action: reconcile on behalf of a different run, run-b.
    const result = reconcileStep(baseInput({
        script: "createTaskWorktree", taskNumber: 1, runId: "run-b", projectRoot: root,
    }));

    // Verification: run-a's completed journal is not handed to run-b as its own completion, and nothing is destroyed by the read-only classification.
    assert.equal(result.status, "ambiguous");
    assert.ok(existsSync(created.worktree));
    assert.ok(existsSync(journalPath));
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.runId, "run-a");
});

// Remediation for phase8-9-audit finding 1 / feedback-phase8-1 finding 1: task state matching the journal was accepted as proof of a finished creation without also requiring the physical lease to name that run. Before the fix this test's assert.equal(status, "ambiguous") would fail: it would report "completed" from task state alone even though no physical lease exists.
test("test_reconcileStep_reportsAmbiguousWhenTaskStateMatchesTheCreateJournalButThePhysicalLeaseIsMissing", () => {
    // Setup: a real worktree/branch exist and task state is recorded to match the journal, but the physical lease file is then removed - task state claims a lease that does not exist.
    const childOrigin = makeCommittedRepo("reconcileStep-journal-nolease-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-journal-nolease-root-", "main");
    addSubmodule(root, childOrigin, "vendor");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    claimTask(1, "run-a", root);
    const group = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" as const };
    const worktree = createWorktreeForGroup(root, group, "run-a");
    updateCurrentTaskRun(1, "run-a", { worktree, leaseRunId: "run-a" }, root);
    unlinkSync(taskWorktreeLeasePath(worktree));
    const journalPath = taskWorktreeCreateJournalPath(worktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: worktree, branch: taskBranchName(1),
        createdAt: "2026-01-01T00:00:00+00:00",
    }));

    // Test action: reconcile for the exact run task state names.
    const result = reconcileStep(baseInput({
        script: "createTaskWorktree", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: task state alone is not accepted as proof, and nothing is destroyed.
    assert.equal(result.status, "ambiguous");
    assert.ok(existsSync(worktree));
    assert.ok(existsSync(journalPath));
});

// F5: one real worktree/notes fixture per shape, reconciled by both isTaskRunResumable's and recordImplementationNotes's handlers, proving they classify every fixture consistently with the shared containment predicate the real production scripts use.
function endedRunRecord(runId: string, implementationNotesFile: string | null): unknown {
    return {
        runId, startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:05:00-07:00",
        exitType: "run-failed", exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile, taskTests: null, fullSuite: null,
    };
}

function activeRunRecord(runId: string, implementationNotesFile: string | null): unknown {
    return {
        runId, startedAt: "2026-08-02T00:00:00-07:00", endedAt: null, exitType: null,
        exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile, taskTests: null, fullSuite: null,
    };
}

// The active run (run-new) already carries notesValue as its OWN implementationNotesFile too, so the same fixture doubles for reconcileRecordImplementationNotes (which reads the exact-runId record) as well as reconcileIsTaskRunResumable (which reads the newest ENDED run's record).
function buildNotesReconciliationFixture(worktreePath: string, notesValue: string): string {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-notes-"));
    writeTasksJson(root, [{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: worktreePath, leaseRunId: "run-new",
            history: [endedRunRecord("run-old", notesValue), activeRunRecord("run-new", notesValue)],
        },
    }]);
    return root;
}

test("test_reconcileStep_classifiesAValidRelativeNotesFileAsContainedForBothHandlers", () => {
    // Setup: a real notes file at a plain relative path inside the worktree.
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-notes-wt-"));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "notes.md"), "notes\n");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-new", pid: 1, createdAt: 1 }));
    const root = buildNotesReconciliationFixture(worktreePath, "plans/notes.md");

    const resumable = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));
    assert.equal(resumable.status, "completed");
    assert.equal(resumable.result?.resumable, true);

    const recorded = reconcileStep(baseInput({
        script: "recordImplementationNotes", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath, implementationNotesFile: "plans/notes.md" },
    }));
    assert.equal(recorded.status, "completed");
});

test("test_reconcileStep_rejectsADotDotEscapeConsistentlyForBothHandlers", () => {
    // Setup: the recorded path walks back out of the worktree with "..". Before the fix,
    // reconcileIsTaskRunResumable used existsSync(join(worktreePath, notesFile)) directly - and
    // Node's path.join collapses ".." the same way path.resolve does, so this existsSync call
    // resolves to the real file OUTSIDE the worktree and (wrongly) finds it, reporting
    // resumable:true. reconcileRecordImplementationNotes only string-compared, so it reported
    // completed regardless.
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-notes-wt-"));
    const escapedFile = join(worktreePath, "..", "escaped-notes.md");
    writeFileSync(escapedFile, "notes\n");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-new", pid: 1, createdAt: 1 }));
    const root = buildNotesReconciliationFixture(worktreePath, "../escaped-notes.md");

    const resumable = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));
    assert.equal(resumable.status, "completed");
    assert.equal(resumable.result?.resumable, false);

    const recorded = reconcileStep(baseInput({
        script: "recordImplementationNotes", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath, implementationNotesFile: "../escaped-notes.md" },
    }));
    assert.equal(recorded.status, "ambiguous");
});

test("test_reconcileStep_rejectsAnAbsoluteOutsidePathConsistentlyForBothHandlers", () => {
    // Setup: the recorded path is absolute and points entirely outside the worktree. Before the fix, reconcileRecordImplementationNotes only string-compared the stored path against intended and never checked containment at all, so it reported completed regardless of where the path actually pointed.
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-notes-wt-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "reconcileStep-notes-outside-"));
    const outsideFile = join(outsideDir, "notes.md");
    writeFileSync(outsideFile, "notes\n");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-new", pid: 1, createdAt: 1 }));
    const root = buildNotesReconciliationFixture(worktreePath, outsideFile);

    const resumable = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));
    assert.equal(resumable.status, "completed");
    assert.equal(resumable.result?.resumable, false);

    const recorded = reconcileStep(baseInput({
        script: "recordImplementationNotes", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath, implementationNotesFile: outsideFile },
    }));
    assert.equal(recorded.status, "ambiguous");
});

test("test_reconcileStep_rejectsASymlinkEscapeConsistentlyForBothHandlers", () => {
    // Setup: a symlink inside the worktree points at a file entirely outside it. Before the fix,
    // reconcileIsTaskRunResumable's raw existsSync(join(...)) follows the symlink and finds the
    // file, wrongly reporting resumable:true; reconcileRecordImplementationNotes's string compare
    // never looked at the filesystem at all.
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-notes-wt-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "reconcileStep-notes-outside-"));
    const outsideFile = join(outsideDir, "real-notes.md");
    writeFileSync(outsideFile, "notes\n");
    const symlinkPath = join(worktreePath, "notes-link.md");
    symlinkSync(outsideFile, symlinkPath);
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-new", pid: 1, createdAt: 1 }));
    const root = buildNotesReconciliationFixture(worktreePath, "notes-link.md");

    const resumable = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));
    assert.equal(resumable.status, "completed");
    assert.equal(resumable.result?.resumable, false);

    const recorded = reconcileStep(baseInput({
        script: "recordImplementationNotes", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath, implementationNotesFile: "notes-link.md" },
    }));
    assert.equal(recorded.status, "ambiguous");
});

test("test_reconcileStep_rejectsADirectoryConsistentlyForBothHandlers", () => {
    // Setup: the recorded path names a real directory, not a file. Before the fix,
    // reconcileIsTaskRunResumable's existsSync(join(...)) is true for a directory too, wrongly
    // reporting resumable:true; reconcileRecordImplementationNotes's string compare never checked
    // that the path was even a file.
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-notes-wt-"));
    mkdirSync(join(worktreePath, "plans", "notes-dir"), { recursive: true });
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-new", pid: 1, createdAt: 1 }));
    const root = buildNotesReconciliationFixture(worktreePath, "plans/notes-dir");

    const resumable = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));
    assert.equal(resumable.status, "completed");
    assert.equal(resumable.result?.resumable, false);

    const recorded = reconcileStep(baseInput({
        script: "recordImplementationNotes", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath, implementationNotesFile: "plans/notes-dir" },
    }));
    assert.equal(recorded.status, "ambiguous");
});

test("test_reconcileStep_rejectsANotesFileDeletedAfterTheMutationConsistentlyForBothHandlers", () => {
    // Setup: the run record names a notes file that is now gone from disk - simulating a successful mutation whose file was deleted afterward. Before the fix, reconcileRecordImplementationNotes only compared the stored string against intended and never checked the file still existed, so it reported completed on the stale record alone.
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-notes-wt-"));
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-new", pid: 1, createdAt: 1 }));
    const root = buildNotesReconciliationFixture(worktreePath, "plans/notes.md");

    const resumable = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));
    assert.equal(resumable.status, "completed");
    assert.equal(resumable.result?.resumable, false);

    const recorded = reconcileStep(baseInput({
        script: "recordImplementationNotes", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath, implementationNotesFile: "plans/notes.md" },
    }));
    assert.equal(recorded.status, "ambiguous");
});

// [Finding 10] Real, per-row fault-injection cases: run the actual mutating script, discard its returned value, reconcile, and compare the reconstructed result/status against the script's own declared Output type field-for-field.

test("test_reconcileStep_recognizesAnActiveClaimAfterALostResult", () => {
    // Setup: a real claim, via the actual isTaskActive script.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-claim-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    const realOutput = isTaskActive(1, "run-a", root);
    assert.equal(realOutput.status, "claimed");

    // Test action: reconcile as if the box's stdout had been lost.
    const result = reconcileStep(baseInput({
        script: "isTaskActive", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the reconstructed result matches IsTaskActiveOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { status: "claimed", heldByRunId: null });
});

test("test_reconcileStep_reportsNotCompletedWhenNoClaimIsActiveUnderThisRun", () => {
    // Setup: the task is claimed under a DIFFERENT run - this run's claim plainly never happened.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-claim-none-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(isTaskActive(1, "run-other", root).status, "claimed");

    const result = reconcileStep(baseInput({
        script: "isTaskActive", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    assert.equal(result.status, "not-completed");
});

test("test_reconcileStep_recognizesAResetWorktreeAfterALostResult", () => {
    // Setup: a real repo with a real submodule, a claimed run, and a real created worktree.
    const childOrigin = makeCommittedRepo("reconcileStep-reset-child-", "child-main");
    const root = makeCommittedRepo("reconcileStep-reset-root-", "main");
    addSubmodule(root, childOrigin, "vendor");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const firstCreate = createTaskWorktree(1, "run-a", root);

    // Test action: reset for real, then discard the returned value.
    const realOutput = resetTaskWorktree(1, "run-a", root);
    assert.equal(realOutput.worktree, firstCreate.worktree);

    const result = reconcileStep(baseInput({
        script: "resetTaskWorktree", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the reconstructed result matches CreateTaskWorktreeOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { worktree: realOutput.worktree, branch: realOutput.branch });

    // Verification: a lease naming a different run is not-completed - the wrong-owner case.
    writeFileSync(taskWorktreeLeasePath(realOutput.worktree), JSON.stringify({ runId: "run-other", pid: 1, createdAt: 1 }));
    const mismatched = reconcileStep(baseInput({
        script: "resetTaskWorktree", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));
    assert.equal(mismatched.status, "not-completed");
});

test("test_reconcileStep_recognizesAGeneratedBriefAfterALostResult", () => {
    const root = makeCommittedRepo("reconcileStep-docs-root-", "main");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);

    // Test action: generate the brief for real, then discard the returned value.
    const realOutput = generateTaskDocs(1, created.worktree, root);

    const result = reconcileStep(baseInput({
        script: "generateTaskDocs", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath: created.worktree },
    }));

    // Verification: the reconstructed result matches GenerateTaskDocsOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { briefFile: realOutput.briefFile });
});

test("test_reconcileStep_reportsNotCompletedWhenTheExpectedBriefIsMissing", () => {
    // The mutation plainly never happened: no brief was ever written to this worktree.
    const root = makeCommittedRepo("reconcileStep-docs-missing-root-", "main");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);

    const result = reconcileStep(baseInput({
        script: "generateTaskDocs", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath: created.worktree },
    }));

    assert.equal(result.status, "not-completed");
});

test("test_reconcileStep_recognizesAnUpdatedBriefAfterALostResult", () => {
    const root = makeCommittedRepo("reconcileStep-updatedocs-root-", "main");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);

    // Test action: update the brief for real, then discard the returned value.
    const realOutput = updateTaskDocs(1, created.worktree, root);

    const result = reconcileStep(baseInput({
        script: "updateTaskDocs", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath: created.worktree },
    }));

    // Verification: the reconstructed result matches UpdateTaskDocsOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { briefFile: realOutput.briefFile });
});

test("test_reconcileStep_recognizesAStoredFullSuiteDecisionAfterALostResult", () => {
    // Setup: a real linked worktree whose root has a discoverable, fast, always-green test script.
    const root = makeCommittedRepo("reconcileStep-fullsuite-root-", "main");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add package.json");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);

    // Test action: run the real full suite, then discard the returned value.
    const realOutput = runFullSuite(1, "run-a", created.worktree, "main", "suite-1", root);
    assert.equal(realOutput.passed, true);

    const result = reconcileStep(baseInput({
        script: "runFullSuite", stepId: "suite-1", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the reconstructed result matches RunFullSuiteOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
        stepId: realOutput.stepId, passed: realOutput.passed, layers: realOutput.layers, output: realOutput.output,
    });

    // Verification: a different stepId is not-completed - that step's own run plainly did not happen.
    const staleStep = reconcileStep(baseInput({
        script: "runFullSuite", stepId: "suite-2", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));
    assert.equal(staleStep.status, "not-completed");
});

test("test_reconcileStep_recognizesAFinishedRebaseAfterALostResult", async () => {
    // Setup: a real linked worktree with root work to rebase cleanly onto source.
    const root = makeCommittedRepo("reconcileStep-rebase-root-", "main");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add package.json");
    const groupId = 900_010;
    const worktreePath = createWorktreeForGroup(root, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    writeTasksJson(root, [{ taskNumber: groupId, title: "t", files: [] }]);
    assert.equal(claimTask(groupId, "run-a", root).status, "claimed");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");

    // Test action: rebase for real, then discard the returned value.
    const realOutput = await rebaseTaskWorktree({
        projectRoot: root, worktreePath, taskNumber: groupId, runId: "run-a", stepId: "rebase-1", rootSourceBranch: "main",
    });
    assert.equal(realOutput.conflicted, false);

    const result = reconcileStep(baseInput({
        script: "rebaseTaskWorktree", stepId: "rebase-1", taskNumber: groupId, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    }));

    // Verification: the reconstructed result matches RebaseTaskWorktreeOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
        lock: "acquired", heldByOwner: null, recoveryCommand: null,
        conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null,
    });
});

test("test_reconcileStep_recognizesAFinishedAdvanceAfterALostResult", async () => {
    // Setup: a real root-level conflict, created by diverging the same file in source and worktree.
    const root = makeCommittedRepo("reconcileStep-advance-root-", "main");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add package.json");
    writeFileSync(join(root, "conflict.txt"), "base\n");
    git(root, "add", "conflict.txt");
    git(root, "commit", "-q", "-m", "add conflict.txt");
    const groupId = 900_011;
    const worktreePath = createWorktreeForGroup(root, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    writeTasksJson(root, [{ taskNumber: groupId, title: "t", files: [] }]);
    assert.equal(claimTask(groupId, "run-a", root).status, "claimed");

    writeFileSync(join(worktreePath, "conflict.txt"), "worktree change\n");
    git(worktreePath, "add", "conflict.txt");
    git(worktreePath, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(root, "conflict.txt"), "source change\n");
    git(root, "add", "conflict.txt");
    git(root, "commit", "-q", "-m", "source edit");

    const rebaseInput = {
        projectRoot: root, worktreePath, taskNumber: groupId, runId: "run-a", stepId: "advance-1", rootSourceBranch: "main",
    };
    const firstAttempt = await rebaseTaskWorktree(rebaseInput);
    assert.equal(firstAttempt.conflicted, true);

    writeFileSync(join(worktreePath, "conflict.txt"), "resolved\n");
    git(worktreePath, "add", "conflict.txt");

    // Test action: advance for real, then discard the returned value.
    const realOutput = advanceTaskRebase({ ...rebaseInput, stoppedAt: firstAttempt.stoppedAt! });
    assert.equal(realOutput.finished, true);

    const result = reconcileStep(baseInput({
        script: "advanceTaskRebase", stepId: "advance-1", taskNumber: groupId, runId: "run-a", projectRoot: root,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    }));

    // Verification: the reconstructed result matches AdvanceTaskRebaseOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
        finished: true, conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null,
    });
});

test("test_reconcileStep_recognizesRecordedMergeCommitsAfterALostResult", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-recordmerge-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    assert.equal(acquireSourceRepoLock(root, buildLockOwner("run-a", 1)).status, "acquired");
    const commits = [{ occurrenceId: "", hash: "abc123", kind: "merge" as const }];

    // Test action: record for real, then discard the returned value.
    const realOutput = recordMergeCommits({ projectRoot: root, taskNumber: 1, runId: "run-a", commits });
    assert.deepEqual(realOutput.commits, commits);

    const result = reconcileStep(baseInput({
        script: "recordMergeCommits", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the reconstructed result matches RecordMergeCommitsOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { commits });

    // Sanity: a task whose record holds no merge-kind commits plainly never got this far.
    const root2 = mkdtempSync(join(tmpdir(), "reconcileStep-recordmerge-none-"));
    writeTasksJson(root2, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-b", root2).status, "claimed");
    const notCompletedResult = reconcileStep(baseInput({
        script: "recordMergeCommits", taskNumber: 1, runId: "run-b", projectRoot: root2,
    }));
    assert.equal(notCompletedResult.status, "not-completed");
});

test("test_reconcileStep_recognizesRecordedModifiedFilesAfterALostResult", () => {
    // Setup: a real linked worktree with a real committed change against its base ref.
    const root = makeCommittedRepo("reconcileStep-modifiedfiles-root-", "main");
    writeTasksJson(root, [{ taskNumber: 1, title: "t", files: [] }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const created = createTaskWorktree(1, "run-a", root);
    writeFileSync(join(created.worktree, "changed.txt"), "changed\n");
    git(created.worktree, "add", "changed.txt");
    git(created.worktree, "commit", "-q", "-m", "task work");

    // Test action: record for real, then discard the returned value.
    const realOutput = recordTaskModifiedFiles({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: created.worktree, sourceBranch: "main",
    });
    assert.deepEqual(realOutput.modifiedFiles, ["changed.txt"]);

    const result = reconcileStep(baseInput({
        script: "recordTaskModifiedFiles", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktree: created.worktree, sourceBranch: "main" },
    }));

    // Verification: the reconstructed result matches RecordTaskModifiedFilesOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { modifiedFiles: realOutput.modifiedFiles });
});

test("test_reconcileStep_recognizesReleasedHoldsAfterALostResult", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-release-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    assert.equal(acquireSourceRepoLock(root, buildLockOwner("run-a", 1)).status, "acquired");

    // Test action: release for real (no worktree/branch to consider), then discard the returned value.
    const realOutput = releaseTaskRunHolds({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: null, branchName: null, stepId: "step-1",
    });
    assert.deepEqual(realOutput, { leaseReleased: false, leaseRetained: false, lockReleased: true });

    const result = reconcileStep(baseInput({
        script: "releaseTaskRunHolds", stepId: "step-1", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the exact real result is reproduced from the receipt, field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);
});

test("test_reconcileStep_recognizesAHoldNotOwnedByThisRunIsNotOursToRelease", () => {
    // Setup: a worktree lease that names a DIFFERENT run - the wrong-owner case for this row.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-release-wrongowner-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-release-wt-"));
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "run-other", pid: 1, createdAt: 1 }));

    // The real script leaves a hold it does not own alone in every case (its own F5 comment).
    const realOutput = releaseTaskRunHolds({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: worktreePath, branchName: null, stepId: "step-1",
    });
    assert.deepEqual(realOutput, { leaseReleased: false, leaseRetained: false, lockReleased: false });

    const result = reconcileStep(baseInput({
        script: "releaseTaskRunHolds", stepId: "step-1", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { worktree: worktreePath },
    }));

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);
});

// F10: no receipt for this stepId - the box never reached its durable write, so reconciliation reports not-completed (a rerun is safe/idempotent) rather than inventing an unknown value.
test("test_reconcileStep_reportsNotCompletedForReleaseHoldsWithNoReceipt", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-release-noreceipt-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");

    const result = reconcileStep(baseInput({
        script: "releaseTaskRunHolds", stepId: "step-never-ran", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    assert.equal(result.status, "not-completed");
});

test("test_reconcileStep_recognizesAnInactiveMarkAfterALostResult", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-inactive-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");

    // Test action: mark inactive for real, then discard the returned value.
    const realOutput = markTaskInactive({ taskNumber: 1, runId: "run-a", projectRoot: root });

    const result = reconcileStep(baseInput({
        script: "markTaskInactive", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the reconstructed result matches MarkTaskInactiveOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { active: false, endedAt: realOutput.endedAt });
});

test("test_reconcileStep_reportsNotCompletedWhenTheRunHasNotBeenEnded", () => {
    // The mutation plainly never happened: this run was never ended.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-inactive-none-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");

    const result = reconcileStep(baseInput({
        script: "markTaskInactive", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    assert.equal(result.status, "not-completed");
});

test("test_reconcileStep_recognizesWrittenExitNotesAfterALostResult", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-exitnotes-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");

    // Test action: write exit notes for real, then discard the returned value.
    const realOutput = writeTaskExitNotes({
        taskNumber: 1, runId: "run-a", projectRoot: root, exitType: "tests-red", exitNote: "one test failed",
    });

    const result = reconcileStep(baseInput({
        script: "writeTaskExitNotes", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { exitType: "tests-red", exitNote: "one test failed" },
    }));

    // Verification: the reconstructed result matches WriteTaskExitNotesOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);
});

// Finding 1 (phase10-audit.md): the box now establishes lease ownership BEFORE deciding resumability, so a lost result must be reconciled the same way even when there are no notes to resume from — that "safe, no notes" path is exactly what the finding says used to strand ownership.
test("test_reconcileStep_recognizesAnEstablishedLeaseAfterALostResultWithNoNotes", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-resumable-lease-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-old", root).status, "claimed");
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-resumable-wt-"));
    updateCurrentTaskRun(1, "run-old", { worktree: worktreePath, leaseRunId: "run-old" }, root);
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    writeTaskExitNotes({ taskNumber: 1, runId: "run-old", projectRoot: root, exitType: "run-failed", exitNote: "died" });
    markTaskInactive({ taskNumber: 1, runId: "run-old", projectRoot: root });
    assert.equal(claimTask(1, "run-new", root).status, "claimed");

    // Test action: run the real box for real, then discard its returned value.
    const realOutput = isTaskRunResumable(1, worktreePath, "run-new", root);

    const result = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));

    // Verification: the reconstructed result matches IsTaskRunResumableOutput field-for-field,
    // and ownership (not resumability) is what reconciliation proved.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);
    assert.equal(realOutput.leaseEstablished, true);
    assert.equal(realOutput.resumable, false);
});

test("test_reconcileStep_reportsNotCompletedWhenTheLeaseIsNotYetEstablished", () => {
    // Setup: the box never ran (or ran and failed to establish ownership) - the physical lease still names a run other than the one being reconciled for.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-resumable-noLease-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-old", root).status, "claimed");
    const worktreePath = mkdtempSync(join(tmpdir(), "reconcileStep-resumable-wt-"));
    updateCurrentTaskRun(1, "run-old", { worktree: worktreePath, leaseRunId: "run-old" }, root);
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-live", pid: 1, createdAt: 1 }));
    writeTaskExitNotes({ taskNumber: 1, runId: "run-old", projectRoot: root, exitType: "run-failed", exitNote: "died" });
    markTaskInactive({ taskNumber: 1, runId: "run-old", projectRoot: root });
    assert.equal(claimTask(1, "run-new", root).status, "claimed");

    const result = reconcileStep(baseInput({
        script: "isTaskRunResumable", taskNumber: 1, runId: "run-new", projectRoot: root,
        stepInput: { worktreePath },
    }));

    assert.equal(result.status, "not-completed");
});

test("test_reconcileStep_reportsNotCompletedWhenExitNotesPlainlyWereNotWritten", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-exitnotes-none-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");

    const result = reconcileStep(baseInput({
        script: "writeTaskExitNotes", taskNumber: 1, runId: "run-a", projectRoot: root,
        stepInput: { exitType: "tests-red", exitNote: "one test failed" },
    }));

    assert.equal(result.status, "not-completed");
});

// Every mutating workflow script mapped to the name(s) of its real fault-injection case(s) above.  A script with no entry, or an entry naming a test that was never actually declared with `test(...)` in this file, fails test_reconcileStep_hasANamedFaultInjectionCaseForEveryMutatingRow below.
test("test_reconcileStep_recognizesAFinishedRunAfterALostResult", () => {
    // Setup: the tail already wrote an exit type and ended the run, then its result was lost.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-finish-"));
    buildEndedCompletedRun(root, 71, "run-finish", "a".repeat(40));

    const output = reconcileStep(baseInput({
        script: "finishTaskRun", taskNumber: 71, runId: "run-finish", projectRoot: root,
    }));

    assert.equal(output.status, "completed");
    assert.equal((output.result as { exitType: string }).exitType, "completed");
});

test("test_reconcileStep_reportsNotCompletedWhenTheRunHasNoExitTypeYet", () => {
    // Setup: the run is active and the tail never wrote anything.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-finish-open-"));
    writeTasksJson(root, [{ taskNumber: 72, title: "t" }]);
    assert.equal(claimTask(72, "run-open", root).status, "claimed");

    const output = reconcileStep(baseInput({
        script: "finishTaskRun", taskNumber: 72, runId: "run-open", projectRoot: root,
    }));

    assert.equal(output.status, "not-completed");
});

test("test_reconcileStep_recognizesAHeldSourceLockAfterALostResult", () => {
    // Setup: the lock box took the lock under this run's owner, then its result was lost.
    const root = makeCommittedRepo("reconcileStep-lock-");
    assert.equal(acquireSourceRepoLock(root, buildLockOwner("run-lock", 73)).status, "acquired");

    const output = reconcileStep(baseInput({
        script: "lockSourceRepo", taskNumber: 73, runId: "run-lock", projectRoot: root,
    }));

    assert.equal(output.status, "completed");
    assert.equal((output.result as { acquired: boolean }).acquired, true);
});

test("test_reconcileStep_reportsNotCompletedWhenAnotherRunHoldsTheSourceLock", () => {
    // Setup: a rival run owns the lock, so this run never acquired it.
    const root = makeCommittedRepo("reconcileStep-lock-rival-");
    assert.equal(acquireSourceRepoLock(root, buildLockOwner("run-rival", 74)).status, "acquired");

    const output = reconcileStep(baseInput({
        script: "lockSourceRepo", taskNumber: 74, runId: "run-lock", projectRoot: root,
    }));

    assert.equal(output.status, "not-completed");
});

test("test_reconcileStep_recognizesAWrittenClarifyRequestAfterALostResult", () => {
    // Setup: the entry already holds the request the lost box was asked to write.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-clarify-"));
    writeTasksJson(root, [{ taskNumber: 75, title: "t", clarifyRequest: "WHICH_DATABASE" }]);

    const output = reconcileStep(baseInput({
        script: "writeClarifyRequest", taskNumber: 75, projectRoot: root,
        stepInput: { clarifyRequest: "WHICH_DATABASE" },
    }));

    assert.equal(output.status, "completed");
});

test("test_reconcileStep_reportsNotCompletedWhenTheEntryHoldsADifferentClarifyRequest", () => {
    // Setup: the entry holds an older request, so this box's write never landed.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-clarify-stale-"));
    writeTasksJson(root, [{ taskNumber: 76, title: "t", clarifyRequest: "AN_OLDER_QUESTION" }]);

    const output = reconcileStep(baseInput({
        script: "writeClarifyRequest", taskNumber: 76, projectRoot: root,
        stepInput: { clarifyRequest: "WHICH_DATABASE" },
    }));

    assert.equal(output.status, "not-completed");
});

test("test_reconcileStep_recognizesAmendedCodexNotesAfterALostResult", () => {
    // Setup: a real tasks.json entry and a real flagged test review.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-amendcodex-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    const review = {
        outcome: "OK" as const, missingFiles: [], message: "", testsThatHoldUp: [],
        issues: [{ testFile: "a.test.ts", testName: "does x", evidence: "e", problem: "p", fix: "f" }],
    };

    // Test action: amend for real, then discard the returned value.
    const realOutput = amendEntryWithCodexNotes({ projectRoot: root, taskNumber: 1, review });

    const result = reconcileStep(baseInput({
        script: "amendEntryWithCodexNotes", taskNumber: 1, projectRoot: root,
        stepInput: { review },
    }));

    // Verification: the reconstructed result matches AmendEntryOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);

    // Verification: an entry holding different notes reports not-completed.
    writeTasksJson(root, [{ taskNumber: 1, title: "t", codexReviewNotes: "stale notes" }]);
    const stale = reconcileStep(baseInput({
        script: "amendEntryWithCodexNotes", taskNumber: 1, projectRoot: root,
        stepInput: { review },
    }));
    assert.equal(stale.status, "not-completed");
});

test("test_reconcileStep_recognizesAmendedFailingTestsNotesAfterALostResult", () => {
    // Setup: a claimed run with a stored red taskTests decision.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-amendfailing-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    assert.equal(claimTask(1, "run-a", root).status, "claimed");
    updateCurrentTaskRun(1, "run-a", {
        taskTests: {
            stepId: "tests-step-1", testFiles: ["a.test.ts"], createdTestFiles: [], deletedTestFiles: [],
            missingTests: false, passed: false, output: "1 failing", checkedAt: "2026-08-01T00:00:00-07:00",
        },
    }, root);

    // Test action: amend for real, then discard the returned value.
    const realOutput = amendEntryWithFailingTests({ projectRoot: root, taskNumber: 1 });

    const result = reconcileStep(baseInput({
        script: "amendEntryWithFailingTests", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));

    // Verification: the reconstructed result matches AmendEntryOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);

    // Verification: an entry holding different notes reports not-completed - run state stays preserved.
    const { tasksPath } = resolveTaskFiles(root);
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    tasks[0].codexReviewNotes = "stale notes";
    writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
    const stale = reconcileStep(baseInput({
        script: "amendEntryWithFailingTests", taskNumber: 1, runId: "run-a", projectRoot: root,
    }));
    assert.equal(stale.status, "not-completed");
});

test("test_reconcileStep_recognizesRecordedPlanReviewFixesAfterALostResult", () => {
    // Setup: a real plan file with a real section a single-fix review targets.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-planreview-fix-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    const planFilePath = join(root, "plan.json");
    writeFileSync(planFilePath, JSON.stringify({ revision: 1, sections: [{ id: "s1", title: "Section 1" }] }));
    const review = {
        outcome: "OK" as const, missingFiles: [], message: "", issues: [], sectionsThatHoldUp: [],
        fixes: [{ sectionId: "s1", fix: "do the thing", durableBecause: "because reasons" }],
    };

    // Test action: record for real, then discard the returned value.
    const realOutput = recordPlanReview({ projectRoot: root, planFilePath, taskNumber: 1, review });

    const result = reconcileStep(baseInput({
        script: "recordPlanReview", taskNumber: 1, projectRoot: root,
        stepInput: { planFilePath, review },
    }));

    // Verification: the reconstructed result matches RecordPlanReviewOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);

    // Verification: an ERROR-outcome review writes nothing, so a rerun is always safe.
    const errorReview = {
        outcome: "ERROR" as const, missingFiles: ["plan.md"], message: "no plan found",
        issues: [], fixes: [], sectionsThatHoldUp: [],
    };
    const errored = reconcileStep(baseInput({
        script: "recordPlanReview", taskNumber: 1, projectRoot: root,
        stepInput: { planFilePath, review: errorReview },
    }));
    assert.equal(errored.status, "not-completed");
});

test("test_reconcileStep_recognizesRecordedPlanReviewNotesAfterALostResult", () => {
    // Setup: a real plan file and a review with enough fixes to require a re-review.
    const root = mkdtempSync(join(tmpdir(), "reconcileStep-planreview-notes-"));
    writeTasksJson(root, [{ taskNumber: 1, title: "t" }]);
    const planFilePath = join(root, "plan.json");
    writeFileSync(planFilePath, JSON.stringify({
        revision: 1, sections: [{ id: "s1", title: "Section 1" }, { id: "s2", title: "Section 2" }],
    }));
    const review = {
        outcome: "OK" as const, missingFiles: [], message: "", issues: [], sectionsThatHoldUp: [],
        fixes: [
            { sectionId: "s1", fix: "fix one", durableBecause: "reason one" },
            { sectionId: "s2", fix: "fix two", durableBecause: "reason two" },
        ],
    };

    // Test action: record for real, then discard the returned value.
    const realOutput = recordPlanReview({ projectRoot: root, planFilePath, taskNumber: 1, review });

    const result = reconcileStep(baseInput({
        script: "recordPlanReview", taskNumber: 1, projectRoot: root,
        stepInput: { planFilePath, review },
    }));

    // Verification: the reconstructed result matches RecordPlanReviewOutput field-for-field.
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, realOutput);
});

const FAULT_INJECTION_CASES: Record<string, string[]> = {
    advanceTaskRebase: ["test_reconcileStep_recognizesAFinishedAdvanceAfterALostResult"],
    amendEntryWithCodexNotes: ["test_reconcileStep_recognizesAmendedCodexNotesAfterALostResult"],
    amendEntryWithFailingTests: ["test_reconcileStep_recognizesAmendedFailingTestsNotesAfterALostResult"],
    applyPlanAmendments: ["test_reconcileStep_recognizesAnAlreadyAppliedAmendment"],
    isTaskActive: ["test_reconcileStep_recognizesAnActiveClaimAfterALostResult"],
    cleanupTaskWorktree: ["test_reconcileStep_recognizesACompletedCleanup"],
    closeTaskRun: ["test_reconcileStep_recognizesACompletedArchiveAfterALostResult"],
    commitTaskWork: ["test_reconcileStep_recognizesACompletedCommitWhenOneLayerHadNothingToCommit"],
    createTaskWorktree: [
        "test_reconcileStep_recognizesACreatedWorktreeAndAdoptedLease",
        "test_reconcileStep_reportsAmbiguousWhenACreateJournalNamesAnOwnerTheLeaseNoLongerMatches",
        "test_reconcileStep_reportsAmbiguousRatherThanCompletingAnotherRunsRetainedCreateJournal",
        "test_reconcileStep_reportsAmbiguousWhenTaskStateMatchesTheCreateJournalButThePhysicalLeaseIsMissing",
    ],
    generateTaskDocs: ["test_reconcileStep_recognizesAGeneratedBriefAfterALostResult"],
    initTaskSubmodules: ["test_reconcileStep_reconstructsInitSubmodulesReceiptForBothInitializedStates"],
    isTaskRunResumable: [
        "test_reconcileStep_classifiesAValidRelativeNotesFileAsContainedForBothHandlers",
        "test_reconcileStep_recognizesAnEstablishedLeaseAfterALostResultWithNoNotes",
    ],
    finishTaskRun: [
        "test_reconcileStep_recognizesAFinishedRunAfterALostResult",
        "test_reconcileStep_reportsNotCompletedWhenTheRunHasNoExitTypeYet",
    ],
    lockSourceRepo: [
        "test_reconcileStep_recognizesAHeldSourceLockAfterALostResult",
        "test_reconcileStep_reportsNotCompletedWhenAnotherRunHoldsTheSourceLock",
    ],
    markTaskInactive: ["test_reconcileStep_recognizesAnInactiveMarkAfterALostResult"],
    mergeTaskWorktree: ["test_reconcileStep_recognizesALandedMergeFromItsPersistenceRef"],
    rebaseTaskWorktree: ["test_reconcileStep_recognizesAFinishedRebaseAfterALostResult"],
    recordImplementationNotes: ["test_reconcileStep_classifiesAValidRelativeNotesFileAsContainedForBothHandlers"],
    recordMergeCommits: ["test_reconcileStep_recognizesRecordedMergeCommitsAfterALostResult"],
    recordPlanReview: [
        "test_reconcileStep_recognizesRecordedPlanReviewFixesAfterALostResult",
        "test_reconcileStep_recognizesRecordedPlanReviewNotesAfterALostResult",
    ],
    recordTaskModifiedFiles: ["test_reconcileStep_recognizesRecordedModifiedFilesAfterALostResult"],
    releaseTaskRunHolds: ["test_reconcileStep_recognizesReleasedHoldsAfterALostResult"],
    resetTaskWorktree: ["test_reconcileStep_recognizesAResetWorktreeAfterALostResult"],
    runFullSuite: ["test_reconcileStep_recognizesAStoredFullSuiteDecisionAfterALostResult"],
    runTaskTests: ["test_reconcileStep_returnsAStoredTaskTestDecisionWithoutRunningTestsAgain"],
    updateTaskDocs: ["test_reconcileStep_recognizesAnUpdatedBriefAfterALostResult"],
    writeClarifyRequest: [
        "test_reconcileStep_recognizesAWrittenClarifyRequestAfterALostResult",
        "test_reconcileStep_reportsNotCompletedWhenTheEntryHoldsADifferentClarifyRequest",
    ],
    writeTaskExitNotes: ["test_reconcileStep_recognizesWrittenExitNotesAfterALostResult"],
};

test("test_reconcileStep_hasANamedFaultInjectionCaseForEveryMutatingRow", () => {
    for (const script of getMutatingWorkflowScripts()) {
        const caseNames = FAULT_INJECTION_CASES[script];
        assert.ok(caseNames !== undefined && caseNames.length > 0, `no fault-injection case is registered for "${script}"`);
        for (const caseName of caseNames) {
            assert.ok(
                registeredCaseNames.has(caseName),
                `"${caseName}" mapped to "${script}" is not a real test declared in this file`,
            );
        }
    }
});
