// Covers the two pieces of step-6 logic that used to be prose in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileFunction, constants as vmConstants } from "node:vm";
import { type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";
import { beginNextLap, buildMergeReport, consumeTaskWorkflowResult, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueAction, nextQueueStep, recordMergedNotClosed, recordStageOutcome, shouldEndQueue } from "../scripts/runMergePhase.ts";

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
    assert.equal(shouldEndQueue(queue, false), "stuck");
});

test("test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 50);
    queue = recordStageOutcome(queue, 50, "rebase-test", { status: "failure", reason: "rebase conflicted: d.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, true), "continue");
});

test("test_shouldEndQueueReportsDoneWhenALapMergedEveryTaskAndLeftNoCarryover", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 60);
    queue = recordStageOutcome(queue, 60, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 60, "merge", { status: "success" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "done");
});

test("test_shouldEndQueueContinuesWhenALapMergedAtLeastOneTaskButLeftCarryoverToRetry", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 61);
    queue = enqueueApprovedTask(queue, 62);
    queue = recordStageOutcome(queue, 61, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 61, "merge", { status: "success" });
    queue = recordStageOutcome(queue, 62, "rebase-test", { status: "failure", reason: "rebase conflicted: h.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "continue");
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

    assert.equal(shouldEndQueue(queue, false), "stuck");
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

test("test_consumeTaskWorkflowResultReturnsAnApprovalViewForPlanImplement", () => {
    const queue = createMergeQueue();
    const consumed = consumeTaskWorkflowResult(queue, {
        task: 200,
        stage: "plan+implement",
        results: [
            { status: "planned", verify: { verdict: "approved", notes: [] } },
            { status: "done", fenceViolations: ["scripts/foo.ts"] },
        ],
    });
    assert.equal(consumed.kind, "approval");
    if (consumed.kind !== "approval") return assert.fail("expected approval result");
    assert.equal(consumed.approval.taskNumber, 200);
    assert.equal(consumed.approval.status, "done");
    assert.deepEqual(consumed.approval.verifier, { verdict: "approved", notes: [] });
    assert.deepEqual(consumed.approval.fenceViolations, ["scripts/foo.ts"]);
});

test("test_consumeTaskWorkflowResultReturnsPlanStatusWhenImplementResultIsAbsent", () => {
    const queue = createMergeQueue();
    const consumed = consumeTaskWorkflowResult(queue, {
        task: 201,
        stage: "plan+implement",
        results: [{ status: "needs-clarification", verify: null }],
    });
    assert.equal(consumed.kind, "approval");
    if (consumed.kind !== "approval") return assert.fail("expected approval result");
    assert.equal(consumed.approval.status, "needs-clarification");
    assert.equal(consumed.approval.verifier, null);
    assert.deepEqual(consumed.approval.fenceViolations, []);
});

test("test_consumeTaskWorkflowResultThrowsOnEmptyResults", () => {
    const queue = createMergeQueue();
    assert.throws(() => consumeTaskWorkflowResult(queue, { task: 202, stage: "rebase-test", results: [] }));
});

test("test_consumeTaskWorkflowResultThrowsWhenAFailedTailResultHasNoLastFailure", () => {
    const queue = createMergeQueue();
    assert.throws(() => consumeTaskWorkflowResult(queue, {
        task: 203,
        stage: "rebase-test",
        results: [{ status: "red" }],
    }));
});

test("test_consumeTaskWorkflowResultThrowsWhenMergedButNotClosedHasNoHashOrCloseError", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 204);
    queue = recordStageOutcome(queue, 204, "rebase-test", { status: "success" });
    assert.throws(() => consumeTaskWorkflowResult(queue, {
        task: 204,
        stage: "merge",
        results: [{ status: "merged-but-not-closed" }],
    }));
});

test("test_consumeTaskWorkflowResultRecordsMergedNotClosedFromARealEnvelope", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 205);
    queue = recordStageOutcome(queue, 205, "rebase-test", { status: "success" });
    const consumed = consumeTaskWorkflowResult(queue, {
        task: 205,
        stage: "merge",
        results: [{ status: "merged-but-not-closed", mergedCommitHash: "deadbeef", closeError: "close failure: x" }],
    });
    assert.equal(consumed.kind, "queue");
    if (consumed.kind !== "queue") return assert.fail("expected queue result");
    assert.deepEqual(consumed.queue.merged, [205]);
    assert.deepEqual(consumed.queue.mergedNotClosed, [
        { taskNumber: 205, commitHash: "deadbeef", lastFailure: "close failure: x" },
    ]);
});

const REPO_ROOT = process.cwd();
const TASK_WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, "skills/tackle-tasks/task.workflow.js"), "utf8")
    .replace("export const meta", "const meta");

type TaskWorkflowResult = { task: number; stage: "plan+implement" | "rebase-test" | "merge"; results: Array<Record<string, unknown>> };
type TaskWorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<TaskWorkflowResult>;

const throwingAgent = async () => { throw new Error("end-to-end merge queue lap must not call an agent"); };
// Mirrors an agent that tried and gave up, so a real conflict reports unresolved instead of throwing.
const givingUpAgent = async () => ({ resolved: false });

// Mirrors runMergeStage in tests/taskWorkflowMergeStage.test.ts, driving the same task.workflow.js source.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>, agent: (...values: unknown[]) => Promise<unknown> = throwingAgent) => {
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent"],
        { filename: join(REPO_ROOT, "skills/tackle-tasks/task.workflow.js"), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as TaskWorkflowRunner;
    return await fn(JSON.stringify({ worktree: worktreePath, ...args }), () => {}, agent);
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
    const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: "unknown" });
    const operationBranch = currentBranchName(worktreePath);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
    writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    const manifest = loadRepositoryManifest(root);
    const repositoryManifest: RepositoryManifest = { ...manifest, occurrences: attachOperationBranch(manifest.occurrences, operationBranch) };
    return { root, worktreePath, repositoryManifest };
};

// A well-behaved planner+implementer: absolute paths only, commits via `git -C`, stages only the owned path.
const scriptedPlanImplementAgent = (taskNumber: number, worktreePath: string, ownedPath: string, applyImplementation: () => void) =>
    async (...values: unknown[]) => {
        const options = values[1] as { label: string };
        if (options.label.startsWith("plan:")) {
            const planFile = join(worktreePath, "plans", `task-${taskNumber}-plan.md`);
            mkdirSync(dirname(planFile), { recursive: true });
            writeFileSync(planFile, `# plan for task ${taskNumber}\n`);
            return { task: taskNumber, status: "planned", planFile, question: "", missingFiles: [] };
        }
        if (options.label.startsWith("verify:")) {
            return { task: taskNumber, verdict: "approved", notes: "", reviewer: "claude", missingFiles: [] };
        }
        if (options.label.startsWith("implement:")) {
            applyImplementation();
            const notesRelative = `plans/task-${taskNumber}-implementation-notes.md`;
            writeFileSync(join(worktreePath, notesRelative), "implementation notes\n");
            git(worktreePath, "add", "--", ownedPath, notesRelative);
            git(worktreePath, "commit", "-q", "-m", `task ${taskNumber}: implement`);
            return { task: taskNumber, status: "done", summary: "implemented the plan", remaining: [], notesFile: join(worktreePath, notesRelative) };
        }
        throw new Error(`unexpected agent label: ${options.label}`);
    };

// A bare origin so prepareTasks.ts's CLI origin-remote gate is satisfied.
const addBareOrigin = (root: string): string => {
    const origin = mkdtempSync(join(tmpdir(), "run-merge-phase-origin-"));
    git(origin, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", origin);
    return origin;
};

// Runs the real prepareTasks.ts CLI, so fixtures exercise the same origin-gated preparation path as production.
const prepareThroughCli = (root: string, taskNumber: number): any => {
    const stdout = execFileSync(
        "node",
        [join(REPO_ROOT, "scripts", "prepareTasks.ts"), String(taskNumber)],
        { cwd: root, encoding: "utf8" },
    );
    return JSON.parse(stdout);
};

const readTasks = (root: string): TaskRecord[] => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"));
const readCompleted = (root: string): TaskRecord[] => JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));

// Production-shaped fixture: real prepareTasks.ts CLI output, discovery-shaped (operationBranch "").
const makeQueueFixtureRepoV2 = (taskNumber: number, ownedFiles: string[]) => {
    // Resolve symlinks (macOS /var -> /private/var) so this matches the CLI subprocess's own process.cwd().
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-")));
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

    const task: TaskRecord = { taskNumber, title: "fixture", files: ownedFiles, blockedBy: [] };
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([task]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    git(root, "add", ".taskTools");
    git(root, "commit", "-q", "-m", "seed task state");

    const origin = addBareOrigin(root);
    const prepared = prepareThroughCli(root, taskNumber);
    const group = prepared.groups.find((entry: { tasks: { number: number }[] }) => entry.tasks[0]?.number === taskNumber);
    const worktreePath = group.worktree;
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));

    const repositoryManifest = prepared.repositoryManifest;
    assert.equal(repositoryManifest.occurrences.every((occurrence: { operationBranch: string }) => occurrence.operationBranch === ""), true);
    return { root, origin, worktreePath, repositoryManifest, prepared };
};

const cleanupQueueFixture = (fixture: { root: string; origin: string; worktreePath: string }): void => {
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.origin, { recursive: true, force: true });
};

test("test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged", async () => {
    const taskNumber = 9101;
    const trace: string[] = [];
    const fixture = makeQueueFixtureRepoV2(taskNumber, ["taskfile.txt"]);
    const { root, worktreePath, repositoryManifest, prepared } = fixture;
    trace.push("prepare");
    try {
        let queue = createMergeQueue();

        const planEnvelope = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "plan+implement", typecheckCommand: prepared.typecheckCommand, sourceRoot: root, repositoryManifest },
            scriptedPlanImplementAgent(taskNumber, worktreePath, "taskfile.txt", () => writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n")),
        );
        trace.push("notification:plan+implement");
        const consumedPlan = consumeTaskWorkflowResult(queue, planEnvelope);
        assert.equal(consumedPlan.kind, "approval");
        if (consumedPlan.kind !== "approval") return assert.fail("expected approval result");
        assert.equal(consumedPlan.approval.status, "done");
        assert.deepEqual(consumedPlan.approval.fenceViolations, []);
        trace.push("gate:approve");
        queue = enqueueApprovedTask(queue, consumedPlan.approval.taskNumber);

        let action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root });
        trace.push("notification:rebase-test");
        const consumedRebaseTest = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumedRebaseTest.kind, "queue");
        if (consumedRebaseTest.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedRebaseTest.status, "green");
        queue = consumedRebaseTest.queue;

        action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "merge" } });
        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root });
        trace.push("notification:merge");
        const consumedMerge = consumeTaskWorkflowResult(queue, mergeResult);
        assert.equal(consumedMerge.kind, "queue");
        if (consumedMerge.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedMerge.status, "merged");
        queue = consumedMerge.queue;

        assert.deepEqual(queue.merged, [taskNumber]);
        assert.equal(nextQueueAction(queue, { any: false, tail: false }).kind, "report");
        // All work landed and nothing is outstanding: the terminal state is "done", not "stuck".
        assert.equal(shouldEndQueue(queue, false), "done");
        assert.deepEqual(buildMergeReport(queue), { unmerged: [], mergedNotClosed: [] });

        const archived = readCompleted(root);
        assert.deepEqual(archived.map((t) => t.taskNumber), [taskNumber]);
        trace.push("close");

        // Assert cleanup before teardown, not silently in finally.
        const openTasks = readTasks(root);
        assert.deepEqual(openTasks, []);
        assert.equal(git(root, "show", "main:taskfile.txt"), "task change");
        assert.equal(existsSync(worktreePath), false);
        assert.throws(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
        trace.push("cleanup");

        assert.deepEqual(trace, ["prepare", "notification:plan+implement", "gate:approve", "notification:rebase-test", "notification:merge", "close", "cleanup"]);
    } finally {
        cleanupQueueFixture(fixture);
    }
});

test("a do-not-approve gate never enqueues or launches tail stages", async () => {
    const taskNumber = 9105;
    const fixture = makeQueueFixtureRepoV2(taskNumber, ["taskfile.txt"]);
    let tailLaunches = 0;

    try {
        let queue = createMergeQueue();
        const notification = await runTaskWorkflowStage(
            fixture.worktreePath,
            {
                task: taskNumber,
                stage: "plan+implement",
                typecheckCommand: fixture.prepared.typecheckCommand,
                sourceRoot: fixture.root,
                repositoryManifest: fixture.repositoryManifest,
            },
            scriptedPlanImplementAgent(
                taskNumber,
                fixture.worktreePath,
                "taskfile.txt",
                () => writeFileSync(join(fixture.worktreePath, "taskfile.txt"), "task change\n"),
            ),
        );

        const consumed = consumeTaskWorkflowResult(queue, notification);
        assert.equal(consumed.kind, "approval");
        if (consumed.kind !== "approval") return assert.fail("expected approval notification");

        // gate rejects: queue is never told to enqueue the approved task.
        const action = nextQueueAction(queue, { any: false, tail: false });
        if (action.kind === "launch") tailLaunches += 1;
        assert.deepEqual(action, { kind: "report", endState: "done" });
        assert.equal(tailLaunches, 0);
        assert.equal(readCompleted(fixture.root).length, 0);
        assert.equal(readTasks(fixture.root).some((task) => task.taskNumber === taskNumber), true);
    } finally {
        cleanupQueueFixture(fixture);
    }
});

test('failed A waits for outstanding B, then retries only after B advances the lap', () => {
    let queue = createMergeQueue();
    let sourceTip = 'tip-before-b';
    const attemptedTips: string[] = [];

    queue = enqueueApprovedTask(queue, 1);
    attemptedTips.push(sourceTip);
    queue = recordStageOutcome(queue, 1, 'rebase-test', {
        status: 'failure', reason: 'A conflict',
    });

    assert.deepEqual(nextQueueAction(queue, { any: true, tail: false }), { kind: 'wait' });
    assert.equal(queue.carryover[0]!.lapsAttempted, 1);
    assert.deepEqual(attemptedTips, ['tip-before-b']);

    queue = enqueueApprovedTask(queue, 2);
    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false }), {
        kind: 'launch', step: { taskNumber: 2, stage: 'rebase-test' },
    });
    queue = recordStageOutcome(queue, 2, 'rebase-test', { status: 'success' });
    queue = recordStageOutcome(queue, 2, 'merge', { status: 'success' });
    sourceTip = 'tip-after-b';

    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false }), {
        kind: 'begin-next-lap',
    });
    queue = beginNextLap(queue);
    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false }), {
        kind: 'launch', step: { taskNumber: 1, stage: 'rebase-test' },
    });
    attemptedTips.push(sourceTip);
    queue = recordStageOutcome(queue, 1, 'rebase-test', {
        status: 'failure', reason: 'A conflict after B',
    });

    assert.deepEqual(attemptedTips, ['tip-before-b', 'tip-after-b']);
    assert.equal(queue.unmerged[0]!.lapsAttempted, 2);
});

test('nextQueueAction refuses to launch a rebase-test or merge while a tail workflow is outstanding, even for an unrelated approved task', () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 1);
    assert.deepEqual(nextQueueAction(queue, { any: true, tail: true }), { kind: 'wait' });
    // An outstanding plan+implement (any: true, tail: false) is not a tail workflow and must not block launch.
    assert.deepEqual(nextQueueAction(queue, { any: true, tail: false }), {
        kind: 'launch', step: { taskNumber: 1, stage: 'rebase-test' },
    });
});

// Two worktrees on one root, so B's real merge advances the tip A rebases onto next.
const makeQueueFixtureRepoWithTwoTasks = (taskA: number, taskB: number) => {
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
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([
        { taskNumber: taskA, title: "fixture A", files: [], blockedBy: [] },
        { taskNumber: taskB, title: "fixture B", files: [], blockedBy: [] },
    ]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");

    const makeWorktree = (taskNumber: number) => {
        const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: "unknown" });
        const operationBranch = currentBranchName(worktreePath);
        mkdirSync(join(worktreePath, "plans"), { recursive: true });
        symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
        mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
        writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
        const manifest = loadRepositoryManifest(root);
        const repositoryManifest: RepositoryManifest = { ...manifest, occurrences: attachOperationBranch(manifest.occurrences, operationBranch) };
        return { worktreePath, repositoryManifest };
    };

    return { root, taskA: makeWorktree(taskA), taskB: makeWorktree(taskB) };
};

test("integration: A's second real rebase-test lands B's merged commit as an ancestor of task A's branch", async () => {
    const taskA = 9102;
    const taskB = 9103;
    const { root, taskA: fixtureA, taskB: fixtureB } = makeQueueFixtureRepoWithTwoTasks(taskA, taskB);
    try {
        writeFileSync(join(fixtureA.worktreePath, "a.txt"), "a change\n");
        git(fixtureA.worktreePath, "add", "a.txt");
        git(fixtureA.worktreePath, "commit", "-q", "-m", "task A change");

        writeFileSync(join(fixtureB.worktreePath, "b.txt"), "b change\n");
        git(fixtureB.worktreePath, "add", "b.txt");
        git(fixtureB.worktreePath, "commit", "-q", "-m", "task B change");

        // A's first real rebase-test, against the tip before B has merged.
        const aFirstRebase = await runTaskWorkflowStage(fixtureA.worktreePath, { task: taskA, stage: "rebase-test", repositoryManifest: fixtureA.repositoryManifest, sourceRoot: root });
        assert.equal((aFirstRebase.results[0] as { status: string }).status, "green");

        // B runs to completion for real: rebase-test then merge.
        const bRebase = await runTaskWorkflowStage(fixtureB.worktreePath, { task: taskB, stage: "rebase-test", repositoryManifest: fixtureB.repositoryManifest, sourceRoot: root });
        assert.equal((bRebase.results[0] as { status: string }).status, "green");
        const bMerge = await runTaskWorkflowStage(fixtureB.worktreePath, { task: taskB, stage: "merge", repositoryManifest: fixtureB.repositoryManifest, sourceRoot: root });
        assert.equal((bMerge.results[0] as { status: string }).status, "merged");

        const mainAfterB = git(root, "rev-parse", "main");

        // A's second real rebase-test now runs against the tip that includes B's merge.
        const aSecondRebase = await runTaskWorkflowStage(fixtureA.worktreePath, { task: taskA, stage: "rebase-test", repositoryManifest: fixtureA.repositoryManifest, sourceRoot: root });
        assert.equal((aSecondRebase.results[0] as { status: string }).status, "green");

        const taskABranchHead = git(fixtureA.worktreePath, "rev-parse", "HEAD");
        assert.doesNotThrow(() => git(root, "merge-base", "--is-ancestor", mainAfterB, taskABranchHead));
    } finally {
        rmSync(fixtureA.worktreePath, { recursive: true, force: true });
        rmSync(fixtureB.worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});

test("test_shouldEndQueueReportsDoneOnAnUntouchedQueueWithNothingToDoAndNoFailures", () => {
    const queue = createMergeQueue();

    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "done");
});

test("test_shouldEndQueueReportsStuckWhenALapMergesNothingAndAPriorLapsFailureIsInUnmerged", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 91);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts again" });

    assert.deepEqual(queue.unmerged, [{ taskNumber: 91, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: i.ts again" }]);
    assert.deepEqual(queue.carryover, []);
    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "stuck");
});

test("test_endToEndQueueFeedsARealMergeStageCleanupFailureIntoRecordStageOutcomeAndBuildMergeReport", async () => {
    const taskNumber = 9102;
    const { root, worktreePath, repositoryManifest } = makeQueueFixtureRepo(taskNumber);
    try {
        writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n");
        git(worktreePath, "add", "taskfile.txt");
        git(worktreePath, "commit", "-q", "-m", "task change");

        let queue = createMergeQueue();
        queue = enqueueApprovedTask(queue, taskNumber);

        let step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "rebase-test" });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root });
        const consumedRebaseTest = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumedRebaseTest.kind, "queue");
        if (consumedRebaseTest.kind !== "queue") assert.fail("expected queue result");
        assert.equal(consumedRebaseTest.status, "green");
        queue = consumedRebaseTest.queue;

        step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "merge" });

        writeFileSync(join(worktreePath, "plans", `task-${taskNumber}-plan.md`), "plan\n");
        writeFileSync(join(worktreePath, "plans", `brief-${taskNumber}.md`), "brief\n");
        git(worktreePath, "add", `plans/task-${taskNumber}-plan.md`, `plans/brief-${taskNumber}.md`);
        git(worktreePath, "commit", "-q", "-m", "plan and brief");

        writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
        chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);

        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root });
        const consumedMerge = consumeTaskWorkflowResult(queue, mergeResult);
        assert.equal(consumedMerge.kind, "queue");
        if (consumedMerge.kind !== "queue") assert.fail("expected queue result");
        assert.equal(consumedMerge.status, "blocked");
        queue = consumedMerge.queue;

        assert.equal(shouldEndQueue(queue, false), "stuck");
        const report = buildMergeReport(queue);
        assert.equal(report.unmerged.length, 1);
        assert.equal(report.unmerged[0]!.taskNumber, taskNumber);
        assert.match(report.unmerged[0]!.lastFailure, /cleanup failed/);
        assert.deepEqual(report.unmerged[0]!.terminalReason, "zero-merge lap ended the queue");
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});

// Production-shaped submodule fixture: real buildWorkflowArguments/loadRepositoryManifest output.
const makeQueueFixtureRepoWithSubmoduleV2 = (taskNumber: number, ownedFiles: string[]) => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const submoduleOrigin = mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-submodule-origin-"));
    git(submoduleOrigin, "init", "-q", "-b", "main");
    git(submoduleOrigin, "config", "user.email", "test@example.com");
    git(submoduleOrigin, "config", "user.name", "Test");
    git(submoduleOrigin, "config", "commit.gpgsign", "false");
    writeFileSync(join(submoduleOrigin, "seed.txt"), "seed\n");
    git(submoduleOrigin, "add", "seed.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "seed");
    writeFileSync(join(submoduleOrigin, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(submoduleOrigin, "add", "package.json");
    git(submoduleOrigin, "commit", "-q", "-m", "add test script");

    // Resolve symlinks (macOS /var -> /private/var) so this matches the CLI subprocess's own process.cwd().
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-")));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    git(root, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(root, "commit", "-q", "-m", "add submodule");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add test script");

    const task: TaskRecord = { taskNumber, title: "fixture", files: ownedFiles, blockedBy: [] };
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([task]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    git(root, "add", ".taskTools");
    git(root, "commit", "-q", "-m", "seed task state");

    const origin = addBareOrigin(root);
    const prepared = prepareThroughCli(root, taskNumber);
    const group = prepared.groups.find((entry: { tasks: { number: number }[] }) => entry.tasks[0]?.number === taskNumber);
    const worktreePath = group.worktree;
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));

    const repositoryManifest = prepared.repositoryManifest;
    assert.equal(repositoryManifest.occurrences.every((occurrence: { operationBranch: string }) => occurrence.operationBranch === ""), true);
    return { root, origin, worktreePath, submoduleOrigin, repositoryManifest, prepared };
};

test("test_endToEndQueueDrivesARealTaskThroughASubmoduleRebaseTestThenMergeAndReportsItMerged", async () => {
    const taskNumber = 9103;
    const trace: string[] = [];
    const fixture = makeQueueFixtureRepoWithSubmoduleV2(taskNumber, ["vendor"]);
    const { root, worktreePath, submoduleOrigin, repositoryManifest, prepared } = fixture;
    trace.push("prepare");
    try {
        let queue = createMergeQueue();

        const planEnvelope = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "plan+implement", typecheckCommand: prepared.typecheckCommand, sourceRoot: root, repositoryManifest },
            scriptedPlanImplementAgent(taskNumber, worktreePath, "vendor", () => {
                writeFileSync(join(worktreePath, "vendor", "vendor-new.txt"), "vendor new\n");
                git(join(worktreePath, "vendor"), "add", "vendor-new.txt");
                git(join(worktreePath, "vendor"), "commit", "-q", "-m", "add vendor-new.txt");
            }),
        );
        trace.push("notification:plan+implement");
        const consumedPlan = consumeTaskWorkflowResult(queue, planEnvelope);
        assert.equal(consumedPlan.kind, "approval");
        if (consumedPlan.kind !== "approval") return assert.fail("expected approval result");
        assert.equal(consumedPlan.approval.status, "done");
        assert.deepEqual(consumedPlan.approval.fenceViolations, []);
        trace.push("gate:approve");
        queue = enqueueApprovedTask(queue, consumedPlan.approval.taskNumber);

        let action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root });
        trace.push("notification:rebase-test");
        const consumedRebaseTest = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumedRebaseTest.kind, "queue");
        if (consumedRebaseTest.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedRebaseTest.status, "green");
        queue = consumedRebaseTest.queue;

        action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "merge" } });
        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root });
        trace.push("notification:merge");
        const consumedMerge = consumeTaskWorkflowResult(queue, mergeResult);
        assert.equal(consumedMerge.kind, "queue");
        if (consumedMerge.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedMerge.status, "merged");
        queue = consumedMerge.queue;

        assert.deepEqual(queue.merged, [taskNumber]);
        assert.equal(nextQueueAction(queue, { any: false, tail: false }).kind, "report");
        // All work landed and nothing is outstanding: the terminal state is "done", not "stuck".
        assert.equal(shouldEndQueue(queue, false), "done");
        assert.deepEqual(buildMergeReport(queue), { unmerged: [], mergedNotClosed: [] });

        const archived = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
        assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber]);
        trace.push("close");

        // Assert close/cleanup before teardown, not silently in finally.
        assert.equal(git(join(root, "vendor"), "show", "main:vendor-new.txt"), "vendor new");
        assert.equal(git(root, "rev-parse", "main:vendor"), git(join(root, "vendor"), "rev-parse", "main"));
        assert.equal(existsSync(worktreePath), false);
        for (const repo of [root, join(root, "vendor")]) {
            assert.throws(() => git(repo, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
        }
        trace.push("cleanup");

        assert.deepEqual(trace, ["prepare", "notification:plan+implement", "gate:approve", "notification:rebase-test", "notification:merge", "close", "cleanup"]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
        rmSync(fixture.origin, { recursive: true, force: true });
    }
});

test("test_endToEndQueueFeedsARealSubmoduleRebaseConflictIntoRecordStageOutcomeAndBuildMergeReport", async () => {
    const taskNumber = 9104;
    const trace: string[] = [];
    const fixture = makeQueueFixtureRepoWithSubmoduleV2(taskNumber, ["vendor"]);
    const { root, worktreePath, submoduleOrigin, repositoryManifest, prepared } = fixture;
    trace.push("prepare");
    try {
        const worktreeVendorPath = join(worktreePath, "vendor");
        const mainVendorPath = join(root, "vendor");

        let queue = createMergeQueue();

        const planEnvelope = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "plan+implement", typecheckCommand: prepared.typecheckCommand, sourceRoot: root, repositoryManifest },
            scriptedPlanImplementAgent(taskNumber, worktreePath, "vendor", () => {
                writeFileSync(join(worktreeVendorPath, "seed.txt"), "from-worktree\n");
                git(worktreeVendorPath, "add", "seed.txt");
                git(worktreeVendorPath, "commit", "-q", "-m", "worktree edit");
            }),
        );
        trace.push("notification:plan+implement");
        const consumedPlan = consumeTaskWorkflowResult(queue, planEnvelope);
        assert.equal(consumedPlan.kind, "approval");
        if (consumedPlan.kind !== "approval") return assert.fail("expected approval result");
        assert.equal(consumedPlan.approval.status, "done");
        assert.deepEqual(consumedPlan.approval.fenceViolations, []);
        trace.push("gate:approve");
        queue = enqueueApprovedTask(queue, consumedPlan.approval.taskNumber);

        writeFileSync(join(mainVendorPath, "seed.txt"), "from-main\n");
        git(mainVendorPath, "add", "seed.txt");
        git(mainVendorPath, "commit", "-q", "-m", "main edit");

        const action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root }, givingUpAgent);
        trace.push("notification:rebase-test");

        const consumed = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumed.kind, "queue");
        if (consumed.kind !== "queue") return assert.fail("expected queue result");
        assert.notEqual(consumed.status, "green");
        queue = consumed.queue;

        assert.deepEqual(trace, ["prepare", "notification:plan+implement", "gate:approve", "notification:rebase-test"]);
        assert.equal(currentLapIsComplete(queue), true);
        assert.deepEqual(queue.merged, []);
        assert.equal(queue.carryover.length, 1);
        assert.equal(queue.carryover[0]!.taskNumber, taskNumber);
        assert.equal(queue.carryover[0]!.lapsAttempted, 1);
        assert.match(queue.carryover[0]!.lastFailure as string, /submodule|vendor/i);
        assert.match(queue.carryover[0]!.lastFailure as string, /conflict|unresolved/i);
        assert.equal(shouldEndQueue(queue, false), "stuck");

        const report = buildMergeReport(queue);
        assert.equal(report.unmerged.length, 1);
        assert.equal(report.unmerged[0]!.taskNumber, taskNumber);
        assert.equal(report.unmerged[0]!.terminalReason, "zero-merge lap ended the queue");
        assert.match(report.unmerged[0]!.lastFailure, /submodule|vendor/i);
        assert.match(report.unmerged[0]!.lastFailure, /conflict|unresolved/i);

        const archived = readCompleted(root);
        assert.deepEqual(archived.map((t) => t.taskNumber), []);

        // A conflict must leave every task ref recoverable: no cleanup ran.
        const openTasks = readTasks(root);
        assert.equal(openTasks.some((t) => t.taskNumber === taskNumber), true);
        assert.equal(existsSync(worktreePath), true);
        // Source submodule fetches the task branch only on merge; a rebase-test conflict has no such ref yet.
        assert.doesNotThrow(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
        rmSync(fixture.origin, { recursive: true, force: true });
    }
});
