// Covers the two pieces of step-6 logic that used to be prose in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compileFunction, constants as vmConstants } from "node:vm";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { beginNextLap, buildMergeReport, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordMergedNotClosed, recordStageOutcome, shouldEndQueue } from "../scripts/runMergePhase.ts";

test("test_hasLapRemainingAllowsExactlyTwoLapsThenStops", () => {
    assert.equal(MAX_LAPS, 2);
    assert.equal(hasLapRemaining(0), true);
    assert.equal(hasLapRemaining(1), true);
    assert.equal(hasLapRemaining(2), false);
});

test("test_judgeMergeRunReportsMergedWhenTheScriptExitsCleanWithNoConflicts", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [{ branch: "new-usage-graph" }] });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "merged");
    assert.equal(verdict.failure, null);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsNonZero", () => {
    const verdict = judgeMergeRun({ exitCode: 1, stdout: "", stderr: "boom" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.equal(verdict.failure?.error, "1: boom");
    assert.deepEqual(verdict.failure?.conflicts, []);
    assert.equal(verdict.failure?.failedCommand, "cmd");
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButReportsConflicts", () => {
    const conflicts = [{ groupId: 1, merged: false }];
    const verdict = judgeMergeRun({ exitCode: 0, stdout: JSON.stringify({ merged: [], conflicts }), stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.deepEqual(verdict.failure?.conflicts, conflicts);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptPrintsSomethingOtherThanJson", () => {
    const verdict = judgeMergeRun({ exitCode: 0, stdout: "Debugger attached.", stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /not JSON/);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButPublishedNothing", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [], runState: { status: "approved" } });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /published nothing/);
});

test("test_recordStageOutcomeRequeuesAFailedTaskToTheBackAndRetriesItNextLapWhileAnotherTaskMerges", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 10);
    queue = enqueueApprovedTask(queue, 20);

    assert.deepEqual(nextQueueStep(queue), { taskNumber: 10, stage: "rebase-test" });
    queue = recordStageOutcome(queue, 10, "rebase-test", { status: "success" });
    assert.deepEqual(nextQueueStep(queue), { taskNumber: 10, stage: "merge" });
    queue = recordStageOutcome(queue, 10, "merge", { status: "success" });
    assert.deepEqual(queue.merged, [10]);

    assert.deepEqual(nextQueueStep(queue), { taskNumber: 20, stage: "rebase-test" });
    queue = recordStageOutcome(queue, 20, "rebase-test", { status: "failure", reason: "rebase conflicted: a.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.deepEqual(queue.merged, [10]);
    assert.deepEqual(queue.unmerged, []);
    assert.deepEqual(queue.carryover, [{ taskNumber: 20, stage: "rebase-test", lapsAttempted: 1, lastFailure: "rebase conflicted: a.ts" }]);

    queue = beginNextLap(queue);
    assert.deepEqual(nextQueueStep(queue), { taskNumber: 20, stage: "rebase-test" });
});

test("test_recordStageOutcomeLeavesATaskUnmergedAfterItsSecondLapFails", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 30);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts again" });

    assert.deepEqual(queue.merged, []);
    assert.deepEqual(queue.carryover, []);
    assert.deepEqual(queue.unmerged, [{ taskNumber: 30, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: b.ts again" }]);
});

test("test_shouldEndQueueEndsTheQueueWhenALapMergesZeroTasksAndNoWorkflowIsOutstanding", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 40);
    queue = recordStageOutcome(queue, 40, "rebase-test", { status: "failure", reason: "rebase conflicted: c.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), true);
});

test("test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 50);
    queue = recordStageOutcome(queue, 50, "rebase-test", { status: "failure", reason: "rebase conflicted: d.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, true), false);
});

test("test_shouldEndQueueDoesNotEndTheQueueWhenALapMergedAtLeastOneTask", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 60);
    queue = recordStageOutcome(queue, 60, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 60, "merge", { status: "success" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), false);
});

test("test_buildMergeReportOmitsATaskThatFailedItsFirstLapButMergedItsSecondLap", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 70);
    queue = recordStageOutcome(queue, 70, "rebase-test", { status: "failure", reason: "rebase conflicted: e.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 70, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 70, "merge", { status: "success" });

    const report = buildMergeReport(queue);

    assert.deepEqual(queue.merged, [70]);
    assert.deepEqual(report.unmerged, []);
});

test("test_buildMergeReportCarriesBothFieldsForATaskThatHitTheTwoLapCeiling", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 80);
    queue = recordStageOutcome(queue, 80, "rebase-test", { status: "failure", reason: "unresolved merge conflict: f.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 80, "rebase-test", { status: "failure", reason: "unresolved merge conflict: f.ts again" });

    const report = buildMergeReport(queue);

    assert.deepEqual(report.unmerged, [
        { taskNumber: 80, lastFailure: "unresolved merge conflict: f.ts again", terminalReason: "2-lap ceiling reached" },
    ]);
});

test("test_buildMergeReportNamesTheQueueExitNotTheCeilingWhenATaskWasStillRetryable", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 90);
    queue = recordStageOutcome(queue, 90, "rebase-test", { status: "failure", reason: "rebase conflicted: g.ts" });

    assert.equal(shouldEndQueue(queue, false), true);
    const report = buildMergeReport(queue);

    assert.deepEqual(report.unmerged, [
        { taskNumber: 90, lastFailure: "rebase conflicted: g.ts", terminalReason: "zero-merge lap ended the queue" },
    ]);
});

test("test_buildMergeReportReportsMergedNotClosedAsItsOwnOutcomeWithTheCommitHash", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 100);
    queue = recordStageOutcome(queue, 100, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 100, "merge", { status: "success" });
    queue = recordMergedNotClosed(queue, 100, "abc123", "close failure: archival reported an incomplete result");

    const report = buildMergeReport(queue);

    assert.deepEqual(queue.merged, [100]);
    assert.deepEqual(report.unmerged, []);
    assert.deepEqual(report.mergedNotClosed, [
        { taskNumber: 100, commitHash: "abc123", lastFailure: "close failure: archival reported an incomplete result" },
    ]);
});

const REPO_ROOT = process.cwd();
const TASK_WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, "skills/tackle-tasks/task.workflow.js"), "utf8")
    .replace("export const meta", "const meta");

type TaskWorkflowResult = { task: number; stage: string; results: Array<Record<string, unknown>> };
type TaskWorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<TaskWorkflowResult>;

const throwingAgent = async () => { throw new Error("end-to-end merge queue lap must not call an agent"); };

// Mirrors runMergeStage in tests/taskWorkflowMergeStage.test.ts, driving the same task.workflow.js source.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>) => {
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent"],
        { filename: join(worktreePath, "task.workflow.js"), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as TaskWorkflowRunner;
    const previousCwd = process.cwd();
    process.chdir(worktreePath);
    try {
        return await fn(JSON.stringify(args), () => {}, throwingAgent);
    } finally {
        process.chdir(previousCwd);
    }
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// Mirrors makeRootWithWorktree in tests/taskWorkflowMergeStage.test.ts, plus seedTaskFiles/seedWorktreeTaskFile.
const makeQueueFixtureRepo = (taskNumber: number) => {
    const root = mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add test script");
    const sourceBranch = "main";
    const baseOid = git(root, "rev-parse", sourceBranch);
    const operationBranch = `task-${taskNumber}`;
    const worktreePath = join(tmpdir(), `run-merge-phase-e2e-wt-${randomUUID()}`);
    git(root, "worktree", "add", "-q", "-b", operationBranch, worktreePath, sourceBranch);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
    writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    const repositoryManifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [{
            occurrenceId: "",
            checkoutPath: root,
            parentOccurrenceId: null,
            pathInParent: null,
            gitlinkOid: null,
            depth: 0,
            originUrl: "",
            baseBranch: sourceBranch,
            baseOid,
            operationBranch,
            childOccurrenceIds: [],
            testState: "untested",
        }],
    };
    return { root, worktreePath, repositoryManifest };
};

test("test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged", async () => {
    const taskNumber = 9101;
    const { root, worktreePath, repositoryManifest } = makeQueueFixtureRepo(taskNumber);
    try {
        writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n");
        git(worktreePath, "add", "taskfile.txt");
        git(worktreePath, "commit", "-q", "-m", "task change");

        let queue = createMergeQueue();
        queue = enqueueApprovedTask(queue, taskNumber);

        let step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "rebase-test" });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest });
        const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
        assert.equal(rebaseTestOutcome.status, "green");
        queue = recordStageOutcome(queue, taskNumber, "rebase-test", { status: "success" });

        step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "merge" });
        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest });
        const mergeOutcome = mergeResult.results[0] as { status: string };
        assert.equal(mergeOutcome.status, "merged");
        queue = recordStageOutcome(queue, taskNumber, "merge", { status: "success" });

        assert.deepEqual(queue.merged, [taskNumber]);
        assert.equal(nextQueueStep(queue), null);
        // shouldEndQueue only fires on a zero-merge lap; a merged lap waits for the next enqueue.
        assert.equal(shouldEndQueue(queue, false), false);
        assert.deepEqual(buildMergeReport(queue), { unmerged: [], mergedNotClosed: [] });

        const archived = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
        assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});
