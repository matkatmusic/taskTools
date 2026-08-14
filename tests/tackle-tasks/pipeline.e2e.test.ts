// Phase 12 end-to-end proof: drives the real green-box scripts in pipeline.mmd order against a
// real repository with a real submodule and a real `git worktree add`. No agents, no workflow
// harness — the driver below stands in for the workflow's control flow only.
// Run alone: node --test tests/tackle-tasks/pipeline.e2e.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveTaskRun } from "../../scripts/tackle-tasks/resolveTaskRun.ts";
import { isTaskNumberValid } from "../../scripts/tackle-tasks/isTaskNumberValid.ts";
import { isTaskOpen } from "../../scripts/tackle-tasks/isTaskOpen.ts";
import { claimTaskRun } from "../../scripts/tackle-tasks/claimTaskRun.ts";
import { isTaskBlocked } from "../../scripts/tackle-tasks/isTaskBlocked.ts";
import { doesTaskWorktreeExist } from "../../scripts/tackle-tasks/doesTaskWorktreeExist.ts";
import { checkTaskWorktreeSafe } from "../../scripts/tackle-tasks/checkTaskWorktreeSafe.ts";
import { isTaskRunResumable } from "../../scripts/tackle-tasks/isTaskRunResumable.ts";
import { createTaskWorktree, taskBranchName } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { generateTaskDocs } from "../../scripts/tackle-tasks/generateTaskDocs.ts";
import { initTaskSubmodules } from "../../scripts/tackle-tasks/initTaskSubmodules.ts";
import { commitTaskWork } from "../../scripts/tackle-tasks/commitTaskWork.ts";
import { runTaskTests } from "../../scripts/tackle-tasks/runTaskTests.ts";
import { rebaseTaskWorktree } from "../../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { advanceTaskRebase } from "../../scripts/tackle-tasks/advanceTaskRebase.ts";
import { runFullSuite } from "../../scripts/tackle-tasks/runFullSuite.ts";
import { checkTaskFileFence } from "../../scripts/tackle-tasks/checkTaskFileFence.ts";
import { mergeTaskWorktree } from "../../scripts/tackle-tasks/mergeTaskWorktree.ts";
import { recordMergeCommits } from "../../scripts/tackle-tasks/recordMergeCommits.ts";
import { writeTaskExitNotes } from "../../scripts/tackle-tasks/writeTaskExitNotes.ts";
import { recordTaskModifiedFiles } from "../../scripts/tackle-tasks/recordTaskModifiedFiles.ts";
import { markTaskInactive } from "../../scripts/tackle-tasks/markTaskInactive.ts";
import { cleanupTaskWorktree } from "../../scripts/tackle-tasks/cleanupTaskWorktree.ts";
import { buildClosureNote } from "../../scripts/tackle-tasks/buildClosureNote.ts";
import { closeTaskRun } from "../../scripts/tackle-tasks/closeTaskRun.ts";
import { releaseTaskRunHolds } from "../../scripts/tackle-tasks/releaseTaskRunHolds.ts";
import { readSourceRepoLock } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { readTaskRunState, type TaskRunRecord, type TaskRunState } from "../../scripts/tackle-tasks/taskRunState.ts";
import type { CloseTaskRunOutput } from "../../scripts/closeTasks.ts";
import { GENERATED_ARTIFACT_PATTERNS } from "../../scripts/tackle-tasks/writeTaskBrief.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";
import { taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";
import { git, makeCommittedRepo, addSubmodule } from "./support/gitFixtures.ts";

// `node --test` sets NODE_TEST_CONTEXT on this file's process. Both test boxes spawn a nested
// `node --test`, which reports to its parent runner and exits 0 while it inherits that variable,
// so a red suite would look green here. The pipeline is never run under a test runner in
// production; the variable is dropped for the same reason a real invocation never has it.
delete process.env.NODE_TEST_CONTEXT;

// --- the fixture repository -------------------------------------------------------------
// Every occurrence needs its own discoverable complete-suite command, so root and submodule
// each get a package.json and a seed test. The seed test reads value.txt, which lets a task
// turn the full suite red without touching any test file its own test box would run.

const SEED_SUITE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("test_seed_valueFileStillReadsOne", () => {
    assert.equal(readFileSync("value.txt", "utf8"), "one\\n");
});
`;

const PASSING_TASK_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";

test("test_task_addsAWidget", () => {
    assert.equal(1, 1);
});
`;

function writeSuiteLayer(repoPath: string): void {
    mkdirSync(join(repoPath, "tests"), { recursive: true });
    writeFileSync(
        join(repoPath, "package.json"),
        `${JSON.stringify({ name: "pipeline-e2e-fixture", private: true, scripts: { test: "node --test tests/*.test.ts" } }, null, 2)}\n`,
    );
    writeFileSync(join(repoPath, "value.txt"), "one\n");
    writeFileSync(join(repoPath, "tests", "seed.test.ts"), SEED_SUITE_TEST);
    // Mirrors plan §1f: generated briefs and notes must never enter a task's committed diff.
    writeFileSync(join(repoPath, ".gitignore"), `${GENERATED_ARTIFACT_PATTERNS.join("\n")}\n`);
    git(repoPath, "add", "package.json", "value.txt", "tests/seed.test.ts", ".gitignore");
    git(repoPath, "commit", "-q", "-m", "suite layer");
}

// A real root repository with a real submodule, both runnable as their own test layer.
function makeSourceRepository(prefix: string): string {
    const childOrigin = makeCommittedRepo(`${prefix}-child-`, "child-main");
    writeSuiteLayer(childOrigin);
    const rootOrigin = makeCommittedRepo(`${prefix}-root-`, "main");
    writeSuiteLayer(rootOrigin);
    addSubmodule(rootOrigin, childOrigin, "child");
    return rootOrigin;
}

function seedTaskFiles(projectRoot: string, tasks: unknown[]): void {
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(dirname(tasksPath), { recursive: true });
    writeJsonAtomically(tasksPath, tasks);
    if (!existsSync(completedTasksPath)) writeJsonAtomically(completedTasksPath, []);
}

function seedTask(projectRoot: string, taskNumber: number, files: string[], extra: Record<string, unknown> = {}): void {
    seedTaskFiles(projectRoot, [{ taskNumber, title: `task ${taskNumber}`, description: "do it", files, ...extra }]);
}

// --- the agent's edits, as plain file writes --------------------------------------------

// Inside the fence and harmless to the seed suite: a new submodule file, a new root test.
function editInsideTheFence(taskNumber: number): (worktreePath: string) => void {
    return (worktreePath) => {
        writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
        writeFileSync(join(worktreePath, "tests", `task-${taskNumber}.test.ts`), PASSING_TASK_TEST);
    };
}

// Inside the fence, but it breaks the seed test that the task's own test box never runs.
function editThatTurnsTheFullSuiteRed(taskNumber: number): (worktreePath: string) => void {
    return (worktreePath) => {
        writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
        writeFileSync(join(worktreePath, "value.txt"), "two\n");
        writeFileSync(join(worktreePath, "tests", `task-${taskNumber}.test.ts`), PASSING_TASK_TEST);
    };
}

// Inside the same fence as the red edit, but it puts the seed test back to green.
function editThatRepairsTheFullSuite(taskNumber: number): (worktreePath: string) => void {
    return (worktreePath) => {
        writeFileSync(join(worktreePath, "child", "widget.txt"), "widget again\n");
        writeFileSync(join(worktreePath, "value.txt"), "one\n");
        writeFileSync(join(worktreePath, "tests", `task-${taskNumber}.test.ts`), PASSING_TASK_TEST);
    };
}

// Outside the fence: a root file the task never declared.
function editOutsideTheFence(taskNumber: number): (worktreePath: string) => void {
    return (worktreePath) => {
        writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
        writeFileSync(join(worktreePath, "tests", `task-${taskNumber}.test.ts`), PASSING_TASK_TEST);
        writeFileSync(join(worktreePath, "undeclared.txt"), "not mine\n");
    };
}

const FENCE_FOR_INSIDE_EDIT = (taskNumber: number) => ["child/widget.txt", `tests/task-${taskNumber}.test.ts`];
const FENCE_FOR_RED_SUITE_EDIT = (taskNumber: number) => ["value.txt", "child/widget.txt", `tests/task-${taskNumber}.test.ts`];

// --- the driver -------------------------------------------------------------------------

type PipelineOptions = {
    projectRoot: string;
    taskNumber: number;
    edit: (worktreePath: string) => void;
    runId?: string;
    stopAfterInactivation?: boolean;
    beforeArchive?: (projectRoot: string) => void;
};

type PipelineOutcome = {
    runId: string;
    exitType: string;
    claimStatus: string;
    worktree: string | null;
    branch: string | null;
    closureNote: string | null;
    closeOutput: CloseTaskRunOutput | null;
};

// The workflow's control flow, expressed as straight-line code: every box below is the real
// script, called in pipeline.mmd order, with no agent and no dispatch harness in between.
async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
    const { projectRoot, taskNumber } = options;
    const resolved = resolveTaskRun(String(taskNumber), projectRoot);
    const runId = options.runId ?? resolved.runId;
    const sourceBranch = resolved.sourceBranch;
    const outcome: PipelineOutcome = {
        runId, exitType: "", claimStatus: "", worktree: null, branch: null, closureNote: null, closeOutput: null,
    };

    if (!isTaskNumberValid(taskNumber, projectRoot).valid) return { ...outcome, exitType: "invalid-number" };
    if (!isTaskOpen(taskNumber, projectRoot).open) return { ...outcome, exitType: "not-open" };

    const claim = claimTaskRun(taskNumber, runId, projectRoot);
    outcome.claimStatus = claim.status;
    if (claim.status !== "claimed") {
        outcome.exitType = claim.status === "not-found" ? "run-failed" : "already-active";
        return outcome;
    }

    // The exit chain: exit notes, modified files, inactivation, then both holds.
    const exitRun = (exitType: string, exitNote: string): PipelineOutcome => {
        writeTaskExitNotes({ taskNumber, runId, projectRoot, exitType, exitNote });
        recordTaskModifiedFiles({ taskNumber, runId, projectRoot, worktree: outcome.worktree, sourceBranch });
        markTaskInactive({ taskNumber, runId, projectRoot });
        releaseTaskRunHolds({
            taskNumber, runId, projectRoot, worktree: outcome.worktree, branchName: outcome.branch, stepId: "step-release",
        });
        outcome.exitType = exitType;
        return outcome;
    };

    if (isTaskBlocked(taskNumber, projectRoot).blocked) return exitRun("blocked", "an open blocker remains");

    const existing = doesTaskWorktreeExist(taskNumber, projectRoot);
    if (existing.exists && existing.worktree !== null) {
        outcome.worktree = existing.worktree;
        outcome.branch = taskBranchName(taskNumber);
        const safety = checkTaskWorktreeSafe(taskNumber, existing.worktree);
        if (!safety.safe) return exitRun("run-failed", `the worktree is unsafe: ${safety.problems.join(", ")}`);
        isTaskRunResumable(taskNumber, existing.worktree, runId, projectRoot);
    } else {
        const created = createTaskWorktree(taskNumber, runId, projectRoot);
        outcome.worktree = created.worktree;
        outcome.branch = created.branch;
    }
    const worktreePath = outcome.worktree!;

    generateTaskDocs(taskNumber, worktreePath, projectRoot);
    initTaskSubmodules({ worktreePath, taskNumber, runId, projectRoot, stepId: "step-init-submodules" });

    options.edit(worktreePath);

    commitTaskWork({ projectRoot, worktreePath, taskNumber, runId, stepId: "step-commit", rootSourceBranch: sourceBranch });

    const taskTests = runTaskTests(taskNumber, runId, worktreePath, sourceBranch, "step-task-tests", projectRoot);
    if (!taskTests.passed) return exitRun("tests-red", "the task tests stayed red");

    const rebase = await rebaseTaskWorktree({
        projectRoot, worktreePath, taskNumber, runId, stepId: "step-rebase", rootSourceBranch: sourceBranch,
    });
    if (rebase.lock !== "acquired") return exitRun("run-failed", `the source lock was ${rebase.lock}`);
    // Phase 8 transition table: the rebase helper's own tests-failed is treated as a red full suite.
    if (rebase.failureReason !== null) {
        const testsFailed = /^(complete-suite|related-tests):/.test(rebase.failureReason);
        if (testsFailed) return exitRun("suite-red", "the full suite stayed red");
        return exitRun("run-failed", rebase.failureReason);
    }
    let stoppedAt = rebase.stoppedAt;
    while (stoppedAt !== null) {
        const advanced = advanceTaskRebase({
            projectRoot, worktreePath, taskNumber, runId, stepId: "step-advance", rootSourceBranch: sourceBranch, stoppedAt,
        });
        if (advanced.conflicted) return exitRun("rebase-stuck", "the rebase stayed conflicted");
        stoppedAt = advanced.finished ? null : advanced.stoppedAt;
    }

    const suite = runFullSuite(taskNumber, runId, worktreePath, sourceBranch, "step-full-suite", projectRoot);    if (!suite.passed) return exitRun("suite-red", "the full suite stayed red");

    const fence = checkTaskFileFence({ projectRoot, worktreePath, taskNumber, runId, rootSourceBranch: sourceBranch });
    if (!fence.inside) return exitRun("fence-violation", `changed files outside the fence: ${fence.violations.join(", ")}`);

    const merge = mergeTaskWorktree({ projectRoot, worktreePath, taskNumber, runId, rootSourceBranch: sourceBranch });
    if (!merge.merged) return exitRun("merge-failed", merge.failureReason ?? "the merge failed");
    recordMergeCommits({ projectRoot, taskNumber, runId, commits: merge.commits });

    // The success tail, in the plan's runnable order.
    writeTaskExitNotes({ taskNumber, runId, projectRoot, exitType: "completed", exitNote: "the task is done" });
    recordTaskModifiedFiles({ taskNumber, runId, projectRoot, worktree: worktreePath, sourceBranch });
    markTaskInactive({ taskNumber, runId, projectRoot });
    outcome.exitType = "completed";
    if (options.stopAfterInactivation === true) return outcome;

    cleanupTaskWorktree({ projectRoot, worktreePath, taskNumber, runId });

    outcome.closureNote = buildClosureNote({ taskNumber, runId, projectRoot }).closureNote;
    options.beforeArchive?.(projectRoot);
    try {
        outcome.closeOutput = closeTaskRun({
            taskNumber, runId, projectRoot, closureNote: outcome.closureNote, stepId: "step-close",
        });
    } catch {
        outcome.closeOutput = null;
    }
    if (outcome.closeOutput === null || !outcome.closeOutput.closed.includes(taskNumber)) {
        // rule 10: the already-ended success tail is reopened as run-failed, never left completed.
        writeTaskExitNotes({
            taskNumber, runId, projectRoot, exitType: "run-failed",
            exitNote: "the archive did not close the task", reopen: true,
        });
        outcome.exitType = "run-failed";
    }
    return outcome;
}

// A completed run is archived out of tasks.json, so its state is read from whichever task file
// still holds the task.
function runStateOf(projectRoot: string, taskNumber: number): TaskRunState {
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    for (const path of [tasksPath, completedTasksPath]) {
        if (!existsSync(path)) continue;
        const tasks = JSON.parse(readFileSync(path, "utf8")) as { taskNumber: number; run?: TaskRunState }[];
        const task = tasks.find((candidate) => candidate.taskNumber === taskNumber);
        if (task?.run !== undefined) return task.run;
    }
    throw new Error(`no recorded run state for task ${taskNumber}`);
}

function newestRun(projectRoot: string, taskNumber: number): TaskRunRecord {
    const history = runStateOf(projectRoot, taskNumber).history;
    return history[history.length - 1];
}

// --- the tests --------------------------------------------------------------------------

test("test_pipeline_claimsTheTaskThenReleasesItAcrossASuccessfulRun", async () => {
    // Setup: a real repo with a real submodule and one open task inside its own fence.
    const projectRoot = makeSourceRepository("pipeline-claim");
    seedTask(projectRoot, 1, FENCE_FOR_INSIDE_EDIT(1));

    // Test action: drive the whole pipeline.
    const outcome = await runPipeline({ projectRoot, taskNumber: 1, edit: editInsideTheFence(1) });

    // Verification: the run claimed the task, finished completed, and left nothing held.
    assert.equal(outcome.claimStatus, "claimed");
    assert.equal(outcome.exitType, "completed");
    const state = runStateOf(projectRoot, 1);
    assert.equal(state.active, false);
    assert.ok(!existsSync(outcome.worktree!), "the worktree survived the run");
    assert.ok(!existsSync(taskWorktreeLeasePath(outcome.worktree!)), "the worktree lease survived the run");
    assert.equal(readSourceRepoLock(projectRoot), null);
});

test("test_pipeline_archivesTheTaskWithEveryCommitIncludingSubmoduleOnes", async () => {
    // Setup: a task whose only file change lives inside the real submodule.
    const projectRoot = makeSourceRepository("pipeline-archive");
    seedTask(projectRoot, 2, FENCE_FOR_INSIDE_EDIT(2));

    // Test action: drive the whole pipeline.
    const outcome = await runPipeline({ projectRoot, taskNumber: 2, edit: editInsideTheFence(2) });

    // Verification: the task is archived, and its recorded commits cover the submodule occurrence
    // as well as the root, with the published merge commits last.
    assert.equal(outcome.exitType, "completed");
    assert.deepEqual(outcome.closeOutput?.closed, [2]);
    const { completedTasksPath } = resolveTaskFiles(projectRoot);
    assert.ok(existsSync(completedTasksPath));
    const commits = newestRun(projectRoot, 2).commits;
    assert.ok(commits.some((commit) => commit.occurrenceId === "child"), "no submodule commit was recorded");
    assert.ok(commits.some((commit) => commit.occurrenceId === ""), "no root commit was recorded");
    assert.ok(commits.some((commit) => commit.kind === "merge"), "no merge commit was recorded");
    assert.equal(commits[commits.length - 1].kind, "merge");
});

test("test_pipeline_writesExitTypeAndExitNotesWhenTheSuiteStaysRed", async () => {
    // Setup: a task whose declared change breaks a seed test its own test box never runs.
    const projectRoot = makeSourceRepository("pipeline-suite-red");
    seedTask(projectRoot, 3, FENCE_FOR_RED_SUITE_EDIT(3));

    // Test action: drive the pipeline until the full suite decides.
    const outcome = await runPipeline({ projectRoot, taskNumber: 3, edit: editThatTurnsTheFullSuiteRed(3) });

    // Verification: the run exited suite-red and both fields are on the record.
    assert.equal(outcome.exitType, "suite-red");
    const record = newestRun(projectRoot, 3);
    assert.equal(record.exitType, "suite-red", `exit note was: ${record.exitNote}`);
    assert.equal(record.exitNote, "the full suite stayed red");
    // The task's own test box was green: only the wider suite went red.
    assert.equal(record.taskTests?.passed, true);
});

test("test_pipeline_leavesTheTaskInactiveAfterEveryExitPathThatWritesState", async () => {
    // Setup + test action: one repo per state-writing exit path.
    const redSuiteRoot = makeSourceRepository("pipeline-inactive-red");
    seedTask(redSuiteRoot, 4, FENCE_FOR_RED_SUITE_EDIT(4));
    const redSuite = await runPipeline({ projectRoot: redSuiteRoot, taskNumber: 4, edit: editThatTurnsTheFullSuiteRed(4) });

    const fenceRoot = makeSourceRepository("pipeline-inactive-fence");
    seedTask(fenceRoot, 5, FENCE_FOR_INSIDE_EDIT(5));
    const fenceViolation = await runPipeline({ projectRoot: fenceRoot, taskNumber: 5, edit: editOutsideTheFence(5) });

    const blockedRoot = makeSourceRepository("pipeline-inactive-blocked");
    seedTaskFiles(blockedRoot, [
        { taskNumber: 6, title: "task 6", description: "do it", files: FENCE_FOR_INSIDE_EDIT(6),
          blockedBy: [{ taskNum: 99, reason: "task 99 is still open" }] },
        { taskNumber: 99, title: "task 99", description: "the blocker", files: [] },
    ]);
    const blocked = await runPipeline({ projectRoot: blockedRoot, taskNumber: 6, edit: editInsideTheFence(6) });

    const completedRoot = makeSourceRepository("pipeline-inactive-completed");
    seedTask(completedRoot, 7, FENCE_FOR_INSIDE_EDIT(7));
    const completed = await runPipeline({ projectRoot: completedRoot, taskNumber: 7, edit: editInsideTheFence(7) });

    // Verification: every path that wrote state ended with an inactive task.
    assert.equal(redSuite.exitType, "suite-red");
    assert.equal(runStateOf(redSuiteRoot, 4).active, false);
    assert.equal(fenceViolation.exitType, "fence-violation");
    assert.equal(runStateOf(fenceRoot, 5).active, false);
    assert.equal(blocked.exitType, "blocked");
    assert.equal(runStateOf(blockedRoot, 6).active, false);
    assert.equal(completed.exitType, "completed");
    assert.equal(runStateOf(completedRoot, 7).active, false);
});

test("test_pipeline_releasesTheSourceLockOnEveryExitPath", async () => {
    // Setup + test action: the same exit paths, checked for a leftover source lock.
    const redSuiteRoot = makeSourceRepository("pipeline-lock-red");
    seedTask(redSuiteRoot, 8, FENCE_FOR_RED_SUITE_EDIT(8));
    await runPipeline({ projectRoot: redSuiteRoot, taskNumber: 8, edit: editThatTurnsTheFullSuiteRed(8) });

    const fenceRoot = makeSourceRepository("pipeline-lock-fence");
    seedTask(fenceRoot, 9, FENCE_FOR_INSIDE_EDIT(9));
    await runPipeline({ projectRoot: fenceRoot, taskNumber: 9, edit: editOutsideTheFence(9) });

    const completedRoot = makeSourceRepository("pipeline-lock-completed");
    seedTask(completedRoot, 10, FENCE_FOR_INSIDE_EDIT(10));
    await runPipeline({ projectRoot: completedRoot, taskNumber: 10, edit: editInsideTheFence(10) });

    // Verification: no exit path leaves the source repository locked.
    assert.equal(readSourceRepoLock(redSuiteRoot), null);
    assert.equal(readSourceRepoLock(fenceRoot), null);
    assert.equal(readSourceRepoLock(completedRoot), null);
});

test("test_pipeline_refusesASecondConcurrentRunOfTheSameTask", async () => {
    // Setup: a task already claimed by a first run that has not ended.
    const projectRoot = makeSourceRepository("pipeline-concurrent");
    seedTask(projectRoot, 11, FENCE_FOR_INSIDE_EDIT(11));
    const first = claimTaskRun(11, "run-first", projectRoot);

    // Test action: a second invocation of the same task tries to claim it.
    const second = claimTaskRun(11, "run-second", projectRoot);

    // Verification: the second claim is refused and names the holder.
    assert.equal(first.status, "claimed");
    assert.equal(second.status, "refused");
    assert.equal(second.heldByRunId, "run-first");
});

test("test_pipeline_refusesASecondClaimBetweenInactivationAndArchive", async () => {
    // Setup: a successful run stopped right after mark task inactive, before the archive.
    const projectRoot = makeSourceRepository("pipeline-closing");
    seedTask(projectRoot, 12, FENCE_FOR_INSIDE_EDIT(12));
    const outcome = await runPipeline({
        projectRoot, taskNumber: 12, edit: editInsideTheFence(12), stopAfterInactivation: true,
    });

    // Test action: a second invocation tries to claim the still-open, now-inactive task.
    const second = claimTaskRun(12, "run-second", projectRoot);

    // Verification: the claim reports closing, distinct from refused (diagram rule 12).
    assert.equal(outcome.exitType, "completed");
    assert.equal(readTaskRunState(12, projectRoot).active, false);
    assert.equal(second.status, "closing");
});

test("test_pipeline_reportsRunFailedWhenArchiveFailsAfterInactivation", async () => {
    // Setup: an archived record for the same task under a different run lands before the archive
    // box, so closing the open record cannot be reconciled.
    const projectRoot = makeSourceRepository("pipeline-archive-fails");
    seedTask(projectRoot, 13, FENCE_FOR_INSIDE_EDIT(13));

    // Test action: drive the pipeline, poisoning the archive just before its box runs.
    const outcome = await runPipeline({
        projectRoot,
        taskNumber: 13,
        edit: editInsideTheFence(13),
        beforeArchive: (root) => writeJsonAtomically(resolveTaskFiles(root).completedTasksPath, [
            { taskNumber: 13, title: "task 13", run: { active: false, worktree: null, leaseRunId: null, history: [] } },
        ]),
    });

    // Verification: the run is reported run-failed, and the already-ended record was reopened to
    // say so rather than left claiming it completed.
    assert.equal(outcome.exitType, "run-failed");
    const record = newestRun(projectRoot, 13);
    assert.equal(record.exitType, "run-failed");
    assert.equal(record.exitNote, "the archive did not close the task");
    assert.equal(readTaskRunState(13, projectRoot).active, false);
});

test("test_pipeline_recognizesACompletedArchiveWhenTheResultIsLost", async () => {
    // Setup: a completed, archived run whose archive result the caller lost.
    const projectRoot = makeSourceRepository("pipeline-lost-archive");
    seedTask(projectRoot, 14, FENCE_FOR_INSIDE_EDIT(14));
    const outcome = await runPipeline({ projectRoot, taskNumber: 14, edit: editInsideTheFence(14) });
    assert.equal(outcome.exitType, "completed");

    // Test action: replay the archive box with the same run and the same closure note.
    const replay = closeTaskRun({
        taskNumber: 14, runId: outcome.runId, projectRoot, closureNote: outcome.closureNote!, stepId: "step-close",
    });

    // Verification: the replay recognizes the completed archive instead of failing or duplicating it.
    assert.deepEqual(replay.closed, [14]);
    assert.deepEqual(replay.ambiguous, []);
});

test("test_pipeline_resumesAPreviousRunAndAdoptsItsWorktreeLease", async () => {
    // Setup: a first run that created a real worktree and then ended without cleaning it up.
    const projectRoot = makeSourceRepository("pipeline-resume");
    seedTask(projectRoot, 15, FENCE_FOR_RED_SUITE_EDIT(15));
    const first = await runPipeline({ projectRoot, taskNumber: 15, edit: editThatTurnsTheFullSuiteRed(15) });
    assert.equal(first.exitType, "suite-red");
    assert.ok(existsSync(first.worktree!));

    // Test action: a second run finds the worktree and adopts its lease.
    const claim = claimTaskRun(15, "run-second", projectRoot);
    const existing = doesTaskWorktreeExist(15, projectRoot);
    const resumable = isTaskRunResumable(15, existing.worktree!, "run-second", projectRoot);

    // Verification: the worktree is reused and the lease now belongs to the second run.
    assert.equal(claim.status, "claimed");
    assert.equal(existing.exists, true);
    assert.equal(existing.worktree, first.worktree);
    assert.equal(resumable.leaseEstablished, true);
    assert.equal(readTaskRunState(15, projectRoot).leaseRunId, "run-second");
});

test("test_pipeline_recordsASecondRunWithoutDestroyingTheFirstRunsHistory", async () => {
    // Setup: a first run that exits suite-red and leaves a durable record.
    const projectRoot = makeSourceRepository("pipeline-history");
    seedTask(projectRoot, 16, FENCE_FOR_RED_SUITE_EDIT(16));
    const first = await runPipeline({ projectRoot, taskNumber: 16, edit: editThatTurnsTheFullSuiteRed(16) });
    assert.equal(first.exitType, "suite-red");

    // Test action: a second run of the same task that repairs the seed test it broke.
    const second = await runPipeline({ projectRoot, taskNumber: 16, edit: editThatRepairsTheFullSuite(16) });

    // Verification: both runs are on the record, oldest first, with the first one untouched.
    assert.equal(second.exitType, "completed");
    const history = runStateOf(projectRoot, 16).history;
    assert.equal(history.length, 2);
    assert.equal(history[0].runId, first.runId);
    assert.equal(history[0].exitType, "suite-red");
    assert.equal(history[1].runId, second.runId);
    assert.equal(history[1].exitType, "completed");
});

test("test_pipeline_runsTwoTaskWorktreeCreationsConcurrentlyWithoutInterference", async () => {
    // Setup: two open tasks in one real repository, each claimed by its own run.
    const projectRoot = makeSourceRepository("pipeline-concurrent-worktrees");
    seedTaskFiles(projectRoot, [
        { taskNumber: 17, title: "task 17", description: "do it", files: FENCE_FOR_INSIDE_EDIT(17) },
        { taskNumber: 18, title: "task 18", description: "do it", files: FENCE_FOR_INSIDE_EDIT(18) },
    ]);
    assert.equal(claimTaskRun(17, "run-17", projectRoot).status, "claimed");
    assert.equal(claimTaskRun(18, "run-18", projectRoot).status, "claimed");

    // Test action: create both real worktrees concurrently.
    const [seventeen, eighteen] = await Promise.all([
        Promise.resolve().then(() => createTaskWorktree(17, "run-17", projectRoot)),
        Promise.resolve().then(() => createTaskWorktree(18, "run-18", projectRoot)),
    ]);

    // Verification: two distinct real worktrees, each on its own branch, each recorded on its own run.
    assert.notEqual(seventeen.worktree, eighteen.worktree);
    assert.ok(existsSync(join(seventeen.worktree, "child", "seed.txt")));
    assert.ok(existsSync(join(eighteen.worktree, "child", "seed.txt")));
    assert.equal(git(seventeen.worktree, "branch", "--show-current"), taskBranchName(17));
    assert.equal(git(eighteen.worktree, "branch", "--show-current"), taskBranchName(18));
    assert.equal(readTaskRunState(17, projectRoot).worktree, seventeen.worktree);
    assert.equal(readTaskRunState(18, projectRoot).worktree, eighteen.worktree);
});
