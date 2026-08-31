// Covers the two pieces of step-6 logic that used to be prose in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
import { type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest, type WorkflowArguments } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";
import { approveRegatedTask, beginNextLap, buildMergeReport, consumeTaskWorkflowResult, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueAction, nextQueueStep, nextSchedulerAction, recordMergedNotClosed, recordStageOutcome, rejectRegatedTask, shouldEndQueue } from "../scripts/runMergePhase.ts";
import { LAP_REMAINING, LAPS_EXHAUSTED, LAP_COMPLETE } from "../scripts/resultCodes.ts";

test("test_hasLapRemainingAllowsExactlyTwoLapsThenStops", () => {
    assert.equal(MAX_LAPS, 2);
    assert.equal(hasLapRemaining(0), LAP_REMAINING);
    assert.equal(hasLapRemaining(1), LAP_REMAINING);
    assert.equal(hasLapRemaining(2), LAPS_EXHAUSTED);
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

    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
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

test("test_recordStageOutcomeTracksSourceProgressSoAChildMergedParentFailedLapDoesNotEndStuck", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 50);
    queue = recordStageOutcome(queue, 50, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 50, "merge", {
        status: "failure",
        reason: "rebase conflict in root (parent-conflicted); unresolved paths: x.ts",
        sourceProgress: true,
    });

    assert.equal(queue.mergedThisLap, 0);
    assert.equal(queue.sourceProgressThisLap, true);
    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
    assert.equal(shouldEndQueue(queue, false), "continue");

    queue = beginNextLap(queue);
    assert.equal(queue.sourceProgressThisLap, false);
    assert.deepEqual(nextQueueStep(queue), { taskNumber: 50, stage: "rebase-test" });
});

test("test_consumeTaskWorkflowResultDerivesSourceProgressFromAFailedMergeEnvelopesCompletedLayers", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 60);
    queue = recordStageOutcome(queue, 60, "rebase-test", { status: "success" });

    const envelope = {
        task: 60,
        stage: "merge" as const,
        results: [{
            status: "parent-conflicted",
            failedAtStage: "merge",
            completedLayers: [
                { occurrenceId: "vendor", checkoutPath: "/repo/vendor", status: "merged", oid: "abc123", mergedCommitOid: "abc123" },
            ],
            checkoutPath: "/repo",
            stage: "merge",
            conflictedFilePaths: ["gateway.ts"],
            failureReason: null,
            lastFailure: "merge failure in root (parent-conflicted); unresolved paths: gateway.ts",
        }],
    };

    const consumed = consumeTaskWorkflowResult(queue, envelope);
    assert.equal(consumed.kind, "queue");
    if (consumed.kind !== "queue") return assert.fail("expected queue result");
    assert.equal(consumed.queue.mergedThisLap, 0);
    assert.equal(consumed.queue.sourceProgressThisLap, true);
    assert.equal(shouldEndQueue(consumed.queue, false), "continue");
    assert.equal(consumed.queue.carryover.length, 1);
    assert.equal(consumed.queue.carryover[0]!.taskNumber, 60);
});

test("test_shouldEndQueueEndsTheQueueWhenALapMergesZeroTasksAndNoWorkflowIsOutstanding", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 40);
    queue = recordStageOutcome(queue, 40, "rebase-test", { status: "failure", reason: "rebase conflicted: c.ts" });

    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
    assert.equal(shouldEndQueue(queue, false), "stuck");
});

test("test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 50);
    queue = recordStageOutcome(queue, 50, "rebase-test", { status: "failure", reason: "rebase conflicted: d.ts" });

    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
    assert.equal(shouldEndQueue(queue, true), "continue");
});

test("test_shouldEndQueueReportsDoneWhenALapMergedEveryTaskAndLeftNoCarryover", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 60);
    queue = recordStageOutcome(queue, 60, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 60, "merge", { status: "success" });

    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
    assert.equal(shouldEndQueue(queue, false), "done");
});

test("test_shouldEndQueueContinuesWhenALapMergedAtLeastOneTaskButLeftCarryoverToRetry", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 61);
    queue = enqueueApprovedTask(queue, 62);
    queue = recordStageOutcome(queue, 61, "rebase-test", { status: "success" });
    queue = recordStageOutcome(queue, 61, "merge", { status: "success" });
    queue = recordStageOutcome(queue, 62, "rebase-test", { status: "failure", reason: "rebase conflicted: h.ts" });

    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
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

// C86-27: a clean green rebase-test (no fence violations) advances straight to merge, same as before.
test("test_consumeTaskWorkflowResultAdvancesACleanGreenRebaseTestToMergeWithoutRequiringARegate", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 300);
    const consumed = consumeTaskWorkflowResult(queue, {
        task: 300,
        stage: "rebase-test",
        results: [{ status: "green", fenceViolations: [] }],
    });
    assert.equal(consumed.kind, "queue");
    if (consumed.kind !== "queue") return assert.fail("expected queue result");
    assert.deepEqual(nextQueueStep(consumed.queue), { taskNumber: 300, stage: "merge" });
    assert.deepEqual(consumed.queue.postApprovalViolations, []);
});

// C86-27: a green rebase-test that also committed cross-layer edits must stop for an explicit re-gate, not merge.
test("test_consumeTaskWorkflowResultHoldsAViolatedGreenRebaseTestForRegateInsteadOfAdvancingToMerge", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 301);
    const violations = [{ occurrenceId: "vendor", path: "vendor/other.ts" }];
    const consumed = consumeTaskWorkflowResult(queue, {
        task: 301,
        stage: "rebase-test",
        results: [{ status: "green", fenceViolations: violations }],
    });
    assert.equal(consumed.kind, "requires-regate");
    if (consumed.kind !== "requires-regate") return assert.fail("expected requires-regate result");
    assert.deepEqual(consumed.approval, { taskNumber: 301, fenceViolations: violations });
    assert.deepEqual(consumed.queue.postApprovalViolations, [{ taskNumber: 301, fenceViolations: violations }]);
    // The task is still pending at rebase-test, but the scheduler must refuse to relaunch it while unresolved.
    assert.deepEqual(consumed.queue.pending[0], { taskNumber: 301, stage: "rebase-test", lapsAttempted: 0, lastFailure: null });
    assert.equal(nextQueueStep(consumed.queue), null);
});

// C86-27: an approved regate clears the hold and advances straight to merge, without re-running rebase-test.
test("test_approveRegatedTaskClearsTheHoldAndAdvancesToMergeWithoutARebaseTestRelaunch", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 302);
    const violations = [{ occurrenceId: "vendor", path: "vendor/other.ts" }];
    const consumed = consumeTaskWorkflowResult(queue, {
        task: 302,
        stage: "rebase-test",
        results: [{ status: "green", fenceViolations: violations }],
    });
    if (consumed.kind !== "requires-regate") return assert.fail("expected requires-regate result");

    const approved = approveRegatedTask(consumed.queue, 302);
    assert.deepEqual(approved.postApprovalViolations, []);
    assert.deepEqual(nextQueueStep(approved), { taskNumber: 302, stage: "merge" });
});

// C86-27: a rejected regate is terminal — the cross-layer edit is already committed, so it never merges or retries.
test("test_rejectRegatedTaskRemovesTheTaskFromTheQueueAndReportsItSeparatelyFromUnmerged", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 303);
    const violations = [{ occurrenceId: "vendor", path: "vendor/other.ts" }];
    const consumed = consumeTaskWorkflowResult(queue, {
        task: 303,
        stage: "rebase-test",
        results: [{ status: "green", fenceViolations: violations }],
    });
    if (consumed.kind !== "requires-regate") return assert.fail("expected requires-regate result");

    const rejected = rejectRegatedTask(consumed.queue, 303, "user rejected the widened fence");
    assert.deepEqual(rejected.pending, []);
    assert.deepEqual(rejected.postApprovalViolations, []);
    assert.deepEqual(rejected.unmerged, []);
    assert.deepEqual(rejected.regateRejected, [{ taskNumber: 303, lastFailure: "user rejected the widened fence" }]);

    const report = buildMergeReport(rejected);
    assert.deepEqual(report.regateRejected, [{ taskNumber: 303, lastFailure: "user rejected the widened fence" }]);
    assert.deepEqual(report.unmerged, []);
});

const REPO_ROOT = process.cwd();
const TASK_WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, "skills/tackle-tasks-v1_1/tackle-tasks.workflow.js"), "utf8")
    .replace("export const meta", "const meta");
const AGENT_PROMPT_EMITTER_PATH = join(REPO_ROOT, "scripts/tackle-tasks_AgentPromptEmitter.ts");

type TaskWorkflowResult = { task: number; stage: "plan+implement" | "rebase-test" | "merge"; results: Array<Record<string, unknown>> };
type WorkflowAgentImpl = (prompt: string, options: { label: string }) => Promise<unknown>;
type TaskWorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: WorkflowAgentImpl) => Promise<TaskWorkflowResult>;

const throwingAgent = async () => { throw new Error("end-to-end merge queue lap must not call an agent"); };

// Every agent() prompt from tackle-tasks.workflow.js is one `node <emitter> <task> <role> <<'TT_PAYLOAD'` command.
const EMITTER_COMMAND_RE = /node (\S+) (\d+) (\S+) <<'TT_PAYLOAD'\n(.*)\nTT_PAYLOAD/;
const DRIVER_RESULT_PREFIX = "Return exactly this JSON as your structured result, with no other keys added or removed:\n";

// Driver roles resolve via the real emitter; judgment roles use the stand-in.
const agentThatRunsRealEmitterAndScriptsJudgment = (scriptedJudgment: WorkflowAgentImpl): WorkflowAgentImpl => async (prompt, options) => {
    const match = prompt.match(EMITTER_COMMAND_RE);
    if (!match) throw new Error(`prompt has no embedded emitter command: ${prompt.slice(0, 200)}`);
    const [, emitterPath, taskArg, role, payloadJson] = match;
    const output = execFileSync("node", [emitterPath!, taskArg!, role!], { input: payloadJson, encoding: "utf8" });
    if (output.startsWith(DRIVER_RESULT_PREFIX)) return JSON.parse(output.slice(DRIVER_RESULT_PREFIX.length).trim());
    return scriptedJudgment(prompt, options);
};

// Mirrors runMergeStage in tests/taskWorkflowMergeStage.test.ts, driving the same tackle-tasks.workflow.js source.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>, judgmentAgent: WorkflowAgentImpl = throwingAgent) => {
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent"],
        { filename: join(REPO_ROOT, "skills/tackle-tasks-v1_1/tackle-tasks.workflow.js") },
    ) as TaskWorkflowRunner;
    return await fn(
        JSON.stringify({ worktree: worktreePath, agentPromptEmitterPath: AGENT_PROMPT_EMITTER_PATH, ...args }),
        () => {},
        agentThatRunsRealEmitterAndScriptsJudgment(judgmentAgent),
    );
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
    const manifest = loadRepositoryManifest(root, "staging");
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

type PreparedPipeline = WorkflowArguments & {
    repositoryManifest: RepositoryManifest;
    runId: string;
};

// Runs the real prepareTasks.ts CLI, so fixtures exercise the same origin-gated preparation path as production.
const prepareThroughCli = (root: string, taskNumber: number): PreparedPipeline => {
    const stdout = execFileSync(
        process.execPath,
        [join(REPO_ROOT, "scripts", "prepareTasks.ts"), String(taskNumber)],
        { cwd: root, encoding: "utf8" },
    );
    return JSON.parse(stdout) as PreparedPipeline;
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
    const group = prepared.groups.find((entry) => entry.tasks[0]?.number === taskNumber);
    if (!group) throw new Error(`prepareTasks did not return task ${taskNumber}`);
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
    // C86-30: preparation must never write brief/plan artifacts into the source checkout.
    const sourceBriefFile = join(root, "plans", `brief-${taskNumber}.md`);
    const sourcePlanFile = join(root, "plans", `task-${taskNumber}-plan.md`);
    const preparedTask = prepared.groups.find((g) => g.tasks[0]!.number === taskNumber)!.tasks[0]!;
    assert.equal(existsSync(sourceBriefFile), false, "after-prepare");
    assert.equal(existsSync(sourcePlanFile), false, "after-prepare");
    assert.ok(preparedTask.briefFile.startsWith(`${worktreePath}/`), "published briefFile is under the worktree");
    assert.ok(preparedTask.planFile.startsWith(`${worktreePath}/`), "published planFile is under the worktree");
    try {
        let queue = createMergeQueue();

        const planEnvelope = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "plan+implement", typecheckCommand: prepared.typecheckCommand, sourceRoot: root, repositoryManifest },
            scriptedPlanImplementAgent(taskNumber, worktreePath, "taskfile.txt", () => writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n")),
        );
        trace.push("notification:plan+implement");
        // C86-30: plan+implement wrote the brief where it's needed — the worktree, not the source.
        assert.equal(existsSync(sourceBriefFile), false, "during-plan");
        assert.equal(existsSync(sourcePlanFile), false, "during-plan");
        assert.equal(existsSync(join(worktreePath, "plans", `brief-${taskNumber}.md`)), true, "during-plan");
        const consumedPlan = consumeTaskWorkflowResult(queue, planEnvelope);
        assert.equal(consumedPlan.kind, "approval");
        if (consumedPlan.kind !== "approval") return assert.fail("expected approval result");
        assert.equal(consumedPlan.approval.status, "done");
        assert.deepEqual(consumedPlan.approval.fenceViolations, []);
        trace.push("gate:approve");
        queue = enqueueApprovedTask(queue, consumedPlan.approval.taskNumber);

        let action = nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root });
        trace.push("notification:rebase-test");
        const consumedRebaseTest = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumedRebaseTest.kind, "queue");
        if (consumedRebaseTest.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedRebaseTest.status, "green");
        queue = consumedRebaseTest.queue;

        action = nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "merge" } });
        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root, runId: prepared.runId });
        trace.push("notification:merge");
        const consumedMerge = consumeTaskWorkflowResult(queue, mergeResult);
        assert.equal(consumedMerge.kind, "queue");
        if (consumedMerge.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedMerge.status, "merged");
        queue = consumedMerge.queue;

        assert.deepEqual(queue.merged, [taskNumber]);
        assert.equal(nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 }).kind, "report");
        // All work landed and nothing is outstanding: the terminal state is "done", not "stuck".
        assert.equal(shouldEndQueue(queue, false), "done");
        assert.deepEqual(buildMergeReport(queue), { unmerged: [], mergedNotClosed: [], cleanupIncomplete: [], regateRejected: [] });

        const archived = readCompleted(root);
        assert.deepEqual(archived.map((t) => t.taskNumber), [taskNumber]);
        trace.push("close");

        // Assert cleanup before teardown, not silently in finally.
        const openTasks = readTasks(root);
        assert.deepEqual(openTasks, []);
        assert.equal(git(root, "show", "staging:taskfile.txt"), "task change");
        assert.equal(existsSync(worktreePath), false);
        assert.throws(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
        // C86-30: the worktree-local brief/plan never existed in source and are gone with the worktree.
        assert.equal(existsSync(sourceBriefFile), false, "after-cleanup");
        assert.equal(existsSync(sourcePlanFile), false, "after-cleanup");
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
        const action = nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 });
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

    assert.deepEqual(nextQueueAction(queue, { any: true, tail: false, total: 1, capacity: 6 }), { kind: 'wait' });
    assert.equal(queue.carryover[0]!.lapsAttempted, 1);
    assert.deepEqual(attemptedTips, ['tip-before-b']);

    queue = enqueueApprovedTask(queue, 2);
    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 }), {
        kind: 'launch', step: { taskNumber: 2, stage: 'rebase-test' },
    });
    queue = recordStageOutcome(queue, 2, 'rebase-test', { status: 'success' });
    queue = recordStageOutcome(queue, 2, 'merge', { status: 'success' });
    sourceTip = 'tip-after-b';

    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 }), {
        kind: 'begin-next-lap',
    });
    queue = beginNextLap(queue);
    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 }), {
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
    assert.deepEqual(nextQueueAction(queue, { any: true, tail: true, total: 1, capacity: 6 }), { kind: 'wait' });
    // An outstanding plan+implement (any: true, tail: false) is not a tail workflow and must not block launch.
    assert.deepEqual(nextQueueAction(queue, { any: true, tail: false, total: 1, capacity: 6 }), {
        kind: 'launch', step: { taskNumber: 1, stage: 'rebase-test' },
    });
});

// C86-24: tail-only nextQueueAction still permits a 7th launch if something else fills the slot.
test('nextQueueAction alone does not know about a competing plan launch', () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 1);
    assert.deepEqual(nextQueueAction(queue, { any: true, tail: false, total: 6, capacity: 6 }), { kind: 'wait' });
    assert.deepEqual(nextQueueAction(queue, { any: true, tail: false, total: 5, capacity: 6 }), {
        kind: 'launch', step: { taskNumber: 1, stage: 'rebase-test' },
    });
});

// C86-24: one selector for every launch kind assigns a freed slot exactly once.
test('nextSchedulerAction assigns a freed slot once when plan and tail are both ready, tail wins', () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 1);
    const ready = { nextPlanTask: 2 };
    // Six plan/implement fill the shared ceiling: neither the tail nor the plan may launch.
    assert.deepEqual(nextSchedulerAction(queue, ready, { any: true, tail: false, total: 6, capacity: 6 }), { kind: 'wait' });
    // A slot frees: exactly one thing launches, and it's the tail (it moves the shared tip).
    assert.deepEqual(nextSchedulerAction(queue, ready, { any: true, tail: false, total: 5, capacity: 6 }), {
        kind: 'launch-tail', step: { taskNumber: 1, stage: 'rebase-test' },
    });
});

test('nextSchedulerAction launches the ready plan when no tail is ready', () => {
    const queue = createMergeQueue();
    const ready = { nextPlanTask: 2 };
    assert.deepEqual(nextSchedulerAction(queue, ready, { any: true, tail: false, total: 5, capacity: 6 }), {
        kind: 'launch-plan', taskNumber: 2,
    });
});

// A tail already outstanding is serialized, but a ready plan may still launch alongside it.
test('nextSchedulerAction lets a ready plan launch alongside an already-outstanding tail', () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 1);
    const ready = { nextPlanTask: 2 };
    assert.deepEqual(nextSchedulerAction(queue, ready, { any: true, tail: true, total: 4, capacity: 6 }), {
        kind: 'launch-plan', taskNumber: 2,
    });
});

test('nextSchedulerAction waits when nothing is ready to launch but a plan is still pending capacity', () => {
    const queue = createMergeQueue();
    const ready = { nextPlanTask: 2 };
    assert.deepEqual(nextSchedulerAction(queue, ready, { any: true, tail: false, total: 6, capacity: 6 }), { kind: 'wait' });
});

test('nextSchedulerAction rolls the next lap once nothing is ready and the lap is done', () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 1);
    queue = enqueueApprovedTask(queue, 2);
    // Task 1 fails (goes to carryover); task 2 merges, so the lap isn't a zero-merge "stuck" lap.
    queue = recordStageOutcome(queue, 1, 'rebase-test', { status: 'failure', reason: 'x' });
    queue = recordStageOutcome(queue, 2, 'rebase-test', { status: 'success' });
    queue = recordStageOutcome(queue, 2, 'merge', { status: 'success' });
    const ready = { nextPlanTask: null };
    assert.deepEqual(nextSchedulerAction(queue, ready, { any: false, tail: false, total: 0, capacity: 6 }), {
        kind: 'begin-next-lap',
    });
});

test('nextSchedulerAction reports once nothing is ready and the queue is done', () => {
    const queue = createMergeQueue();
    const ready = { nextPlanTask: null };
    assert.deepEqual(nextSchedulerAction(queue, ready, { any: false, tail: false, total: 0, capacity: 6 }), {
        kind: 'report', endState: 'done',
    });
});

// C86-24: an executable harness driving nextSchedulerAction through a real launch/completion sequence.
const makeSchedulerHarness = (taskNumbers: number[], capacity: number) => {
    let queue = createMergeQueue();
    let remainingPlans = [...taskNumbers];
    let outstanding = { any: false, tail: false, total: 0, capacity };
    let peakOutstanding = 0;
    let maxConcurrentTails = 0;
    const launches: string[] = [];

    const addTotal = (delta: number, tail: boolean) => {
        const total = outstanding.total + delta;
        outstanding = { any: total > 0, tail, total, capacity };
        peakOutstanding = Math.max(peakOutstanding, total);
    };

    const dispatchUntilWait = () => {
        while (true) {
            const ready = { nextPlanTask: remainingPlans[0] ?? null };
            const action = nextSchedulerAction(queue, ready, outstanding);
            if (action.kind === 'launch-plan') {
                assert.equal(remainingPlans[0], action.taskNumber, 'launched a plan task out of order');
                remainingPlans = remainingPlans.slice(1);
                addTotal(1, outstanding.tail);
                launches.push(`plan:${action.taskNumber}`);
                continue;
            }
            if (action.kind === 'launch-tail') {
                assert.equal(outstanding.tail, false, 'launched a second tail while one was already outstanding');
                addTotal(1, true);
                maxConcurrentTails = Math.max(maxConcurrentTails, 1);
                launches.push(`tail:${action.step.taskNumber}:${action.step.stage}`);
                continue;
            }
            return action;
        }
    };

    return {
        dispatchUntilWait,
        approve: (taskNumber: number) => { queue = enqueueApprovedTask(queue, taskNumber); },
        completePlan: () => addTotal(-1, outstanding.tail),
        completeTail: (taskNumber: number, stage: 'rebase-test' | 'merge') => {
            queue = recordStageOutcome(queue, taskNumber, stage, { status: 'success' });
            addTotal(-1, false);
        },
        get peakOutstanding() { return peakOutstanding; },
        get maxConcurrentTails() { return maxConcurrentTails; },
        launches,
    };
};

test('nextSchedulerAction harness: a tail approved before its plan-completion frees the slot wins the freed slot', () => {
    const harness = makeSchedulerHarness([1, 2, 3, 4, 5, 6, 7], 6);
    assert.deepEqual(harness.dispatchUntilWait(), { kind: 'wait' });
    assert.deepEqual(harness.launches, [1, 2, 3, 4, 5, 6].map((n) => `plan:${n}`));
    assert.equal(harness.peakOutstanding, 6);

    // Production order: the approval gate runs before the completion frees task 1's slot.
    harness.approve(1);
    harness.completePlan();
    assert.deepEqual(harness.dispatchUntilWait(), { kind: 'wait' });
    assert.deepEqual(harness.launches.at(-1), 'tail:1:rebase-test');
    assert.equal(harness.peakOutstanding, 6);

    harness.completeTail(1, 'rebase-test');
    assert.deepEqual(harness.dispatchUntilWait(), { kind: 'wait' });
    assert.deepEqual(harness.launches.at(-1), 'tail:1:merge');
    assert.equal(harness.maxConcurrentTails, 1);

    harness.completeTail(1, 'merge');
    assert.deepEqual(harness.dispatchUntilWait(), { kind: 'wait' });
    assert.deepEqual(harness.launches.at(-1), 'plan:7');
    assert.equal(harness.peakOutstanding, 6);
});

test('nextSchedulerAction harness: a plan-completion that frees the slot before approval lets the next plan launch instead, and the late tail then serializes', () => {
    const harness = makeSchedulerHarness([1, 2, 3, 4, 5, 6, 7], 6);
    harness.dispatchUntilWait();

    // Reversed order: dispatch sees the freed slot before task 1's approval is enqueued, so plan 7 fills it.
    harness.completePlan();
    assert.deepEqual(harness.dispatchUntilWait(), { kind: 'wait' });
    assert.deepEqual(harness.launches.at(-1), 'plan:7');
    assert.equal(harness.peakOutstanding, 6);

    // Approval now arrives, but capacity is already full again: the tail must wait.
    harness.approve(1);
    assert.deepEqual(harness.dispatchUntilWait(), { kind: 'wait' });
    assert.deepEqual(harness.launches.at(-1), 'plan:7');

    // Task 2 completing frees exactly one slot, which the now-ready tail claims.
    harness.completePlan();
    assert.deepEqual(harness.dispatchUntilWait(), { kind: 'wait' });
    assert.deepEqual(harness.launches.at(-1), 'tail:1:rebase-test');
    assert.equal(harness.maxConcurrentTails, 1);
    assert.equal(harness.peakOutstanding, 6);
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
        const runId = `run-${taskNumber}`;
        const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: "unknown" }, runId);
        const operationBranch = currentBranchName(worktreePath);
        mkdirSync(join(worktreePath, "plans"), { recursive: true });
        symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
        mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
        writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
        const manifest = loadRepositoryManifest(root, "staging");
        const repositoryManifest: RepositoryManifest = { ...manifest, occurrences: attachOperationBranch(manifest.occurrences, operationBranch) };
        return { worktreePath, repositoryManifest, runId };
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
        const bMerge = await runTaskWorkflowStage(fixtureB.worktreePath, { task: taskB, stage: "merge", repositoryManifest: fixtureB.repositoryManifest, sourceRoot: root, runId: fixtureB.runId });
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

    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
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
    assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
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
    const group = prepared.groups.find((entry) => entry.tasks[0]?.number === taskNumber);
    if (!group) throw new Error(`prepareTasks did not return task ${taskNumber}`);
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
    const fixture = makeQueueFixtureRepoWithSubmoduleV2(taskNumber, ["vendor/vendor-new.txt"]);
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

        let action = nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root });
        trace.push("notification:rebase-test");
        const consumedRebaseTest = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumedRebaseTest.kind, "queue");
        if (consumedRebaseTest.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedRebaseTest.status, "green");
        queue = consumedRebaseTest.queue;

        action = nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "merge" } });
        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root, runId: prepared.runId });
        trace.push("notification:merge");
        const consumedMerge = consumeTaskWorkflowResult(queue, mergeResult);
        assert.equal(consumedMerge.kind, "queue");
        if (consumedMerge.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedMerge.status, "merged");
        queue = consumedMerge.queue;

        assert.deepEqual(queue.merged, [taskNumber]);
        assert.equal(nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 }).kind, "report");
        // All work landed and nothing is outstanding: the terminal state is "done", not "stuck".
        assert.equal(shouldEndQueue(queue, false), "done");
        assert.deepEqual(buildMergeReport(queue), { unmerged: [], mergedNotClosed: [], cleanupIncomplete: [], regateRejected: [] });

        const archived = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
        assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber]);
        trace.push("close");

        // Assert close/cleanup before teardown, not silently in finally.
        assert.equal(git(join(root, "vendor"), "show", "main:vendor-new.txt"), "vendor new");
        assert.equal(git(root, "rev-parse", "staging:vendor"), git(join(root, "vendor"), "rev-parse", "main"));
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

test("test_endToEndQueueRetainsRootAndSourceSubmoduleRefsAfterARealMergeConflict", async () => {
    const taskNumber = 9104;
    const trace: string[] = [];
    const fixture = makeQueueFixtureRepoWithSubmoduleV2(taskNumber, ["vendor/seed.txt"]);
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

        // Prove the serial tail reached a green rebase-test before the source-side conflict is introduced.
        let action = nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root },
        );
        trace.push("notification:rebase-test");
        const consumedRebase = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumedRebase.kind, "queue");
        if (consumedRebase.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedRebase.status, "green");
        queue = consumedRebase.queue;

        // Advance canonical vendor after the green check, so merge fetches task-N then conflicts rebasing it.
        writeFileSync(join(mainVendorPath, "seed.txt"), "from-main\n");
        git(mainVendorPath, "add", "seed.txt");
        git(mainVendorPath, "commit", "-q", "-m", "main edit after green rebase-test");

        action = nextQueueAction(queue, { any: false, tail: false, total: 0, capacity: 6 });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "merge" } });
        const mergeResult = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root },
        );
        trace.push("notification:merge");
        const consumedMerge = consumeTaskWorkflowResult(queue, mergeResult);
        assert.equal(consumedMerge.kind, "queue");
        if (consumedMerge.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedMerge.status, "submodule-conflicted");
        queue = consumedMerge.queue;

        assert.deepEqual(trace, [
            "prepare",
            "notification:plan+implement",
            "gate:approve",
            "notification:rebase-test",
            "notification:merge",
        ]);
        assert.equal(currentLapIsComplete(queue), LAP_COMPLETE);
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
        assert.deepEqual(readCompleted(root), []);
        assert.equal(readTasks(root).some((task) => task.taskNumber === taskNumber), true);
        assert.equal(existsSync(worktreePath), true);

        // mergeTaskDeepestFirst fetched task-N into canonical vendor before the conflicting rebase.
        for (const repo of [root, mainVendorPath]) {
            assert.doesNotThrow(() =>
                git(repo, "show-ref", "--verify", `refs/heads/task-${taskNumber}`),
            );
        }
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
        rmSync(fixture.origin, { recursive: true, force: true });
    }
});

// C86-19 negative control: an unowned nested edit must be fenced by its normalized path, not the bare gitlink.
test("plan+implement fences an unowned nested submodule edit by its normalized path, not the bare gitlink", async () => {
    const taskNumber = 9107;
    const fixture = makeQueueFixtureRepoWithSubmoduleV2(taskNumber, ["vendor/seed.txt"]);
    const { root, worktreePath, submoduleOrigin, repositoryManifest, prepared } = fixture;
    try {
        const scriptedAgent = async (...values: unknown[]) => {
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
                const vendorPath = join(worktreePath, "vendor");
                writeFileSync(join(vendorPath, "seed.txt"), "owned edit\n");
                git(vendorPath, "add", "seed.txt");
                git(vendorPath, "commit", "-q", "-m", "owned edit");
                // An unowned nested file, committed alongside the owned edit in the same submodule checkout.
                writeFileSync(join(vendorPath, "other.txt"), "unowned\n");
                git(vendorPath, "add", "other.txt");
                git(vendorPath, "commit", "-q", "-m", "unowned edit");

                const notesRelative = `plans/task-${taskNumber}-implementation-notes.md`;
                writeFileSync(join(worktreePath, notesRelative), "implementation notes\n");
                git(worktreePath, "add", "--", "vendor", notesRelative);
                git(worktreePath, "commit", "-q", "-m", `task ${taskNumber}: implement`);
                return { task: taskNumber, status: "done", summary: "implemented the plan", remaining: [], notesFile: join(worktreePath, notesRelative) };
            }
            throw new Error(`unexpected agent label: ${options.label}`);
        };

        const envelope = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "plan+implement", typecheckCommand: prepared.typecheckCommand, sourceRoot: root, repositoryManifest },
            scriptedAgent,
        );

        const implementResult = envelope.results[1] as { status: string; fenceViolations: string[] };
        assert.equal(implementResult.status, "done");
        assert.deepEqual(implementResult.fenceViolations, ["vendor/other.txt"]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
        rmSync(fixture.origin, { recursive: true, force: true });
    }
});

// C86-19: the literal worker commit sequence must commit a grandchild-owned file through every ancestor occurrence.
test("literal worker commit steps commit a grandchild-owned file through every ancestor occurrence, deepest-first", () => {
    const taskNumber = 9108;
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const nestedOrigin = mkdtempSync(join(tmpdir(), "run-merge-phase-nested-origin-"));
    git(nestedOrigin, "init", "-q", "-b", "main");
    git(nestedOrigin, "config", "user.email", "test@example.com");
    git(nestedOrigin, "config", "user.name", "Test");
    git(nestedOrigin, "config", "commit.gpgsign", "false");
    writeFileSync(join(nestedOrigin, "seed.txt"), "seed\n");
    git(nestedOrigin, "add", "seed.txt");
    git(nestedOrigin, "commit", "-q", "-m", "seed");

    const vendorOrigin = mkdtempSync(join(tmpdir(), "run-merge-phase-vendor-origin-"));
    git(vendorOrigin, "init", "-q", "-b", "main");
    git(vendorOrigin, "config", "user.email", "test@example.com");
    git(vendorOrigin, "config", "user.name", "Test");
    git(vendorOrigin, "config", "commit.gpgsign", "false");
    writeFileSync(join(vendorOrigin, "seed.txt"), "seed\n");
    git(vendorOrigin, "add", "seed.txt");
    git(vendorOrigin, "commit", "-q", "-m", "seed");
    git(vendorOrigin, "submodule", "add", "-q", nestedOrigin, "nested");
    git(vendorOrigin, "commit", "-q", "-m", "add nested submodule");
    writeFileSync(join(vendorOrigin, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add test script");

    const root = realpathSync(mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-")));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    git(root, "submodule", "add", "-q", vendorOrigin, "vendor");
    // `submodule add` never recurses: the source checkout's own "vendor/nested" needs its own init too.
    git(join(root, "vendor"), "submodule", "update", "--init");
    git(join(root, "vendor", "nested"), "checkout", "-q", "main");
    git(root, "commit", "-q", "-m", "add vendor submodule");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add test script");

    const task: TaskRecord = { taskNumber, title: "fixture", files: ["vendor/nested/x.ts"], blockedBy: [] };
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([task]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    git(root, "add", ".taskTools");
    git(root, "commit", "-q", "-m", "seed task state");

    const origin = addBareOrigin(root);
    const prepared = prepareThroughCli(root, taskNumber);
    const group = prepared.groups.find((entry) => entry.tasks[0]?.number === taskNumber);
    if (!group) throw new Error(`prepareTasks did not return task ${taskNumber}`);
    const worktreePath = group.worktree;
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));

    const repositoryManifest = prepared.repositoryManifest;
    const vendorPath = join(worktreePath, "vendor");
    const nestedPath = join(vendorPath, "nested");

    try {
        const beforeRootOid = git(worktreePath, "rev-parse", "HEAD");
        const beforeVendorOid = git(vendorPath, "rev-parse", "HEAD");
        const beforeNestedOid = git(nestedPath, "rev-parse", "HEAD");

        // An unowned grandchild edit, committed the same way a real agent would before running the generated steps.
        writeFileSync(join(nestedPath, "other.txt"), "unowned\n");
        git(nestedPath, "add", "other.txt");
        git(nestedPath, "commit", "-q", "-m", "unowned edit");

        // Owned edit at grandchild depth.
        writeFileSync(join(nestedPath, "x.ts"), "owned\n");
        const notesRelative = `plans/task-${taskNumber}-implementation-notes.md`;
        writeFileSync(join(worktreePath, notesRelative), "implementation notes\n");

        const brief = execFileSync(
            "node", [AGENT_PROMPT_EMITTER_PATH, String(taskNumber), "implement"],
            { input: JSON.stringify({ worktree: worktreePath, sourceRoot: root, runId: prepared.runId, repositoryManifest }), encoding: "utf8" },
        );
        const runLines = [...brief.matchAll(/^run: (.+)$/gm)].map((match) => match[1]!);
        assert.ok(runLines.length >= 6, `expected at least 3 commit steps (6 lines), got: ${runLines.length}`);
        for (const line of runLines) execFileSync("sh", ["-c", line]);

        // Every ancestor now records the grandchild's new OID as its child gitlink, deepest-first.
        const nestedHeadOid = git(nestedPath, "rev-parse", "HEAD");
        assert.notEqual(nestedHeadOid, beforeNestedOid);
        assert.equal(git(vendorPath, "rev-parse", "HEAD:nested"), nestedHeadOid);
        const vendorHeadOid = git(vendorPath, "rev-parse", "HEAD");
        assert.notEqual(vendorHeadOid, beforeVendorOid);
        assert.equal(git(worktreePath, "rev-parse", "HEAD:vendor"), vendorHeadOid);
        assert.notEqual(git(worktreePath, "rev-parse", "HEAD"), beforeRootOid);
        // A gitlink is opaque to its parent's object store; read the owned file from its own occurrence.
        assert.equal(git(nestedPath, "show", "HEAD:x.ts"), "owned");

        // The unowned grandchild edit is reported at its fully normalized nested path, not the bare gitlink.
        const finalize = execFileSync(
            "node", [AGENT_PROMPT_EMITTER_PATH, String(taskNumber), "implement-finalize"],
            {
                input: JSON.stringify({
                    worktree: worktreePath, sourceRoot: root, repositoryManifest, notesRelative,
                    baseOids: { "": beforeRootOid, vendor: beforeVendorOid, "vendor/nested": beforeNestedOid },
                }),
                encoding: "utf8",
            },
        );
        const finalizeResult = JSON.parse(finalize.slice(finalize.indexOf("{")));
        assert.deepEqual(new Set(finalizeResult.changedPaths), new Set([notesRelative, "vendor/nested/x.ts", "vendor/nested/other.txt"]));
        assert.equal(finalizeResult.notesPresent, true);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(vendorOrigin, { recursive: true, force: true });
        rmSync(nestedOrigin, { recursive: true, force: true });
        rmSync(origin, { recursive: true, force: true });
    }
});
