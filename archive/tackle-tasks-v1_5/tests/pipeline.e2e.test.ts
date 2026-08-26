// Phase 12 proof: an agentless driver walks pipeline.mmd against a real repo; green boxes run real code, yellow are fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveTaskRun } from "../scripts/tackle-tasks/resolveTaskRun.ts";
import { isTaskNumberValid } from "../scripts/tackle-tasks/isTaskNumberValid.ts";
import { isTaskActive } from "../scripts/tackle-tasks/isTaskActive.ts";
import { isTaskBlocked } from "../scripts/tackle-tasks/isTaskBlocked.ts";
import { doesTaskWorktreeExist } from "../scripts/tackle-tasks/doesTaskWorktreeExist.ts";
import { checkTaskWorktreeSafe } from "../scripts/tackle-tasks/checkTaskWorktreeSafe.ts";
import { isTaskRunResumable } from "../scripts/tackle-tasks/isTaskRunResumable.ts";
import { createTaskWorktree, taskBranchName } from "../scripts/tackle-tasks/createTaskWorktree.ts";
import { resetTaskWorktree } from "../scripts/tackle-tasks/resetTaskWorktree.ts";
import { generateTaskDocs } from "../scripts/tackle-tasks/generateTaskDocs.ts";
import { updateTaskDocs } from "../scripts/tackle-tasks/updateTaskDocs.ts";
import { initTaskSubmodules } from "../scripts/tackle-tasks/initTaskSubmodules.ts";
import { validatePlanFile } from "../scripts/tackle-tasks/validatePlanFile.ts";
import { validateCodexReview } from "../scripts/tackle-tasks/validateCodexReview.ts";
import { runApplyPlanAmendmentsCli } from "../scripts/tackle-tasks/applyPlanAmendments.ts";
import { recordImplementationNotes } from "../scripts/tackle-tasks/recordImplementationNotes.ts";
import { commitTaskWork } from "../scripts/tackle-tasks/commitTaskWork.ts";
import { runTaskTests } from "../scripts/tackle-tasks/runTaskTests.ts";
import { rebaseTaskWorktree, type BoundedLockWaitOptions } from "../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { advanceTaskRebase } from "../scripts/tackle-tasks/advanceTaskRebase.ts";
import { runFullSuite } from "../scripts/tackle-tasks/runFullSuite.ts";
import { checkTaskFileFence } from "../scripts/tackle-tasks/checkTaskFileFence.ts";
import { mergeTaskWorktree, type MergeTaskWorktreeOutput } from "../scripts/tackle-tasks/mergeTaskWorktree.ts";
import { recordMergeCommits } from "../scripts/tackle-tasks/recordMergeCommits.ts";
import { writeTaskExitNotes } from "../scripts/tackle-tasks/writeTaskExitNotes.ts";
import { recordTaskModifiedFiles } from "../scripts/tackle-tasks/recordTaskModifiedFiles.ts";
import { markTaskInactive } from "../scripts/tackle-tasks/markTaskInactive.ts";
import { cleanupTaskWorktree } from "../scripts/tackle-tasks/cleanupTaskWorktree.ts";
import { buildClosureNote } from "../scripts/tackle-tasks/buildClosureNote.ts";
import { closeTaskRun } from "../scripts/tackle-tasks/closeTaskRun.ts";
import { releaseTaskRunHolds } from "../scripts/tackle-tasks/releaseTaskRunHolds.ts";
import { reconcileStep } from "../scripts/tackle-tasks/reconcileStep.ts";
import {
    acquireSourceRepoLock, buildLockOwner, readSourceRepoLock, releaseSourceRepoLock, STALE_HEARTBEAT_MS,
} from "../scripts/tackle-tasks/sourceRepoLock.ts";
import { readTaskRunState, type TaskRunRecord, type TaskRunState } from "../scripts/tackle-tasks/taskRunState.ts";
import type { CloseTaskRunOutput } from "../scripts/closeTasks.ts";
import { GENERATED_ARTIFACT_PATTERNS } from "../scripts/tackle-tasks/writeTaskBrief.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../scripts/taskStateLock.ts";
import { git, makeCommittedRepo, addSubmodule } from "./support/gitFixtures.ts";

// `node --test` sets NODE_TEST_CONTEXT, making a nested `node --test` report success falsely; the variable is dropped before spawning.
delete process.env.NODE_TEST_CONTEXT;

// --- the fixture repository -------------------------------------------------------------
// Every occurrence needs its own discoverable complete-suite command, so root and submodule each get a package.json and a seed test. The seed test reads value.txt, which lets a task turn the full suite red without touching any test file its own test box would run.

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
    // No test reads this file, so two branches can fight over it without touching the suite.
    writeFileSync(join(repoPath, "contested.txt"), "base\n");
    writeFileSync(join(repoPath, "tests", "seed.test.ts"), SEED_SUITE_TEST);
    // Mirrors plan §1f: generated briefs, plans and notes must never enter a task's committed diff.
    writeFileSync(join(repoPath, ".gitignore"), `${GENERATED_ARTIFACT_PATTERNS.join("\n")}\n`);
    git(repoPath, "add", "package.json", "value.txt", "contested.txt", "tests/seed.test.ts", ".gitignore");
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

// Advances the source root's own branch so a later rebase has something real to replay onto.
function advanceSourceRootBranch(projectRoot: string, contents: string): void {
    writeFileSync(join(projectRoot, "contested.txt"), contents);
    git(projectRoot, "add", "contested.txt");
    git(projectRoot, "commit", "-q", "-m", "source advances contested.txt");
}

// --- the yellow (prose) boxes, as deterministic fixture callbacks -------------------------

type BoxContext = { projectRoot: string; taskNumber: number; runId: string; worktreePath: string };

type ProseBoxes = {
    planTheTask: (context: BoxContext, attempt: number) => void;
    codexReviewsThePlan: (context: BoxContext, attempt: number) => void;
    implementTask: (context: BoxContext) => string | null;
    fixTheCodebaseForTaskTests: (context: BoxContext, attempt: number) => void;
    codexReviewsTests: (context: BoxContext, attempt: number) => "flagged" | "clean";
    amendTheTests: (context: BoxContext, attempt: number) => void;
    fixConflicts: (context: BoxContext, conflictedFilePaths: string[], attempt: number) => void;
    fixTheCodebaseForTheSuite: (context: BoxContext, attempt: number) => void;
};

function planFilePathOf(context: BoxContext): string {
    return join(context.worktreePath, "plans", "plan.json");
}

function reviewFilePathOf(context: BoxContext): string {
    return join(context.worktreePath, "plans", "codex-review.json");
}

function writeJsonFile(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const DEFAULT_PROSE_BOXES: ProseBoxes = {
    planTheTask: (context) => writeJsonFile(planFilePathOf(context), {
        task: context.taskNumber,
        revision: 1,
        createsFiles: [],
        sections: [{ id: "scope", title: "Scope", body: "do the declared work" }],
    }),
    codexReviewsThePlan: (context) => writeJsonFile(reviewFilePathOf(context), {
        verdict: "amend",
        amendments: [{ op: "replace", id: "scope", body: "do the declared work, reviewed" }],
    }),
    implementTask: () => null,
    fixTheCodebaseForTaskTests: () => undefined,
    codexReviewsTests: () => "clean",
    amendTheTests: () => undefined,
    fixConflicts: () => undefined,
    fixTheCodebaseForTheSuite: () => undefined,
};

// The implement box for a task that stays inside its fence and leaves the suite green.
function implementInsideTheFence(context: BoxContext): string | null {
    writeFileSync(join(context.worktreePath, "child", "widget.txt"), "widget\n");
    writeFileSync(join(context.worktreePath, "tests", `task-${context.taskNumber}.test.ts`), PASSING_TASK_TEST);
    return writeImplementationNotes(context);
}

// Inside the fence, but it breaks the seed test that the task's own test box never runs.
function implementAndBreakTheSuite(context: BoxContext): string | null {
    writeFileSync(join(context.worktreePath, "child", "widget.txt"), "widget\n");
    writeFileSync(join(context.worktreePath, "value.txt"), "two\n");
    writeFileSync(join(context.worktreePath, "tests", `task-${context.taskNumber}.test.ts`), PASSING_TASK_TEST);
    return writeImplementationNotes(context);
}

// Inside the same fence as the breaking edit, but it puts the seed test back to green.
function implementAndRepairTheSuite(context: BoxContext): string | null {
    writeFileSync(join(context.worktreePath, "child", "widget.txt"), "widget again\n");
    writeFileSync(join(context.worktreePath, "value.txt"), "one\n");
    writeFileSync(join(context.worktreePath, "tests", `task-${context.taskNumber}.test.ts`), PASSING_TASK_TEST);
    return writeImplementationNotes(context);
}

// Outside the fence: a root file the task never declared.
function implementOutsideTheFence(context: BoxContext): string | null {
    writeFileSync(join(context.worktreePath, "undeclared.txt"), "not mine\n");
    return implementInsideTheFence(context);
}

// A task test the task's own test box runs and finds red.
function implementWithARedTaskTest(context: BoxContext): string | null {
    writeFileSync(join(context.worktreePath, "child", "widget.txt"), "widget\n");
    writeFileSync(
        join(context.worktreePath, "tests", `task-${context.taskNumber}.test.ts`),
        PASSING_TASK_TEST.replace("assert.equal(1, 1);", "assert.equal(1, 2);"),
    );
    return writeImplementationNotes(context);
}

function writeImplementationNotes(context: BoxContext): string {
    const notesFile = join(context.worktreePath, "plans", `implementation-notes-${context.taskNumber}.md`);
    mkdirSync(dirname(notesFile), { recursive: true });
    writeFileSync(notesFile, `# task ${context.taskNumber}\n\nstopped after the declared edits\n`);
    return notesFile;
}

const FENCE_INSIDE = (taskNumber: number) => ["child/widget.txt", `tests/task-${taskNumber}.test.ts`];
const FENCE_WITH_VALUE = (taskNumber: number) => ["value.txt", "child/widget.txt", `tests/task-${taskNumber}.test.ts`];

// --- the driver ---------------------------------------------------------------------------

// Every box the driver may be told to fail operationally (diagram rule 10).
type FailableBox =
    | "isTaskBlocked" | "createTaskWorktree" | "initTaskSubmodules" | "commitTaskWork"
    | "runTaskTests" | "mergeTaskWorktree" | "cleanupTaskWorktree" | "closeTaskRun";

type PipelineOptions = {
    projectRoot: string;
    taskNumber: number;
    runId?: string;
    prose?: Partial<ProseBoxes>;
    // Diagram rule 11: run the close box, throw its stdout away, and reconcile instead of retrying.
    loseCloseResult?: boolean;
    // Diagram rule 10: make one green box fail operationally.
    failAt?: FailableBox;
    // A merge outcome the fixture forces, for the merge-retry and merge-failed edges.
    forcedMergeOutcomes?: MergeTaskWorktreeOutput[];
    stopAfterInactivation?: boolean;
    beforeArchive?: (projectRoot: string) => void;
    beforeUpdateTaskDocs?: (context: BoxContext, resumable: boolean) => void;
    // The production wait is two minutes at a ten-second poll; a scenario tightens it.
    lockOptions?: BoundedLockWaitOptions;
    onHeldSourceLock?: (heldByOwner: string | null, visit: number) => void;
};

type PipelineOutcome = {
    runId: string;
    exitType: string;
    exitNote: string;
    claimStatus: string;
    worktree: string | null;
    branch: string | null;
    closureNote: string | null;
    closeOutput: CloseTaskRunOutput | null;
    // The verdict the existing-worktree path observed, so a scenario can assert it directly.
    resumable: boolean | null;
    visited: string[];
};

const MAX_ATTEMPTS = 2;
// The diagram re-enters the rebase box for as long as the lock stays warm. This cap is a test harness guard only, so a scenario that never releases the lock fails instead of hanging.
const MAX_HELD_LOCK_REENTRIES = 10;

class OperationalFailure extends Error {}

// The rebase helpers run each layer's tests themselves and report the failure as "<failedCheck>: <output>". Phase 8's transition table treats that as a red full suite.
function isTestsFailedReason(failureReason: string): boolean {
    return /^(complete-suite|related-tests):/.test(failureReason);
}

// The driver walks pipeline.mmd node for node. `node` names the diagram node, so the control flow can be read against the diagram directly, and every green box is recorded in `visited`.
async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
    const { projectRoot, taskNumber } = options;
    const prose: ProseBoxes = { ...DEFAULT_PROSE_BOXES, ...options.prose };
    const resolved = resolveTaskRun(String(taskNumber), projectRoot);
    const runId = options.runId ?? resolved.runId;
    const sourceBranch = resolved.sourceBranch;
    const forcedMergeOutcomes = [...(options.forcedMergeOutcomes ?? [])];

    const outcome: PipelineOutcome = {
        runId, exitType: "", exitNote: "", claimStatus: "", worktree: null, branch: null,
        closureNote: null, closeOutput: null, resumable: null, visited: [],
    };

    let stepCounter = 0;
    const nextStepId = (box: string): string => `${runId}-${box}-${++stepCounter}`;

    // Every green box goes through here: it records the visit and honours a rule 10 injection.
    function box<T>(name: string, call: () => T): T {
        outcome.visited.push(name);
        if (options.failAt === name) throw new OperationalFailure(`${name} failed operationally`);
        return call();
    }
    async function asyncBox<T>(name: string, call: () => Promise<T>): Promise<T> {
        outcome.visited.push(name);
        if (options.failAt === name) throw new OperationalFailure(`${name} failed operationally`);
        return await call();
    }

    const contextOf = (): BoxContext => ({ projectRoot, taskNumber, runId, worktreePath: outcome.worktree! });

    // EXIT -> REC -> OFF -> REL. Rule 10 case "claimed, no worktree" reaches it with worktree null, and recordTaskModifiedFiles then records [].
    function runExitChain(exitType: string, exitNote: string): PipelineOutcome {
        box("writeTaskExitNotes", () => writeTaskExitNotes({ taskNumber, runId, projectRoot, exitType, exitNote }));
        box("recordTaskModifiedFiles", () => recordTaskModifiedFiles({
            taskNumber, runId, projectRoot, worktree: outcome.worktree, sourceBranch,
        }));
        box("markTaskInactive", () => markTaskInactive({ taskNumber, runId, projectRoot }));
        box("releaseTaskRunHolds", () => releaseTaskRunHolds({
            taskNumber, runId, projectRoot, worktree: outcome.worktree, branchName: outcome.branch,
            stepId: nextStepId("releaseTaskRunHolds"),
        }));
        outcome.exitType = exitType;
        outcome.exitNote = exitNote;
        return outcome;
    }

    let planScraps = 0;
    let testFixes = 0;
    let testAmendments = 0;
    let conflictFixes = 0;
    let suiteFixes = 0;
    let mergeAttempts = 0;
    let planAttempts = 0;
    let heldLockVisits = 0;
    let claimed = false;
    let ended = false;
    let stoppedAt: { occurrenceId: string; checkoutPath: string } | null = null;
    let conflictedFilePaths: string[] = [];

    let node = "QV";
    try {
        for (;;) {
            switch (node) {
                case "QV": {
                    const valid = box("isTaskNumberValid", () => isTaskNumberValid(taskNumber, projectRoot)).valid;
                    if (!valid) {
                        outcome.exitType = "invalid-number";
                        outcome.exitNote = "task number is in neither tasks.json nor completedTasks.json";
                        return outcome;
                    }
                    node = "MARK";
                    break;
                }
                case "MARK": {
                    const claim = box("isTaskActive", () => isTaskActive(taskNumber, runId, projectRoot));
                    outcome.claimStatus = claim.status;
                    if (claim.status !== "claimed") {
                        outcome.exitType = claim.status === "not-found" ? "run-failed" : "already-active";
                        outcome.exitNote = "a previous run left the claim held";
                        return outcome;
                    }
                    claimed = true;
                    node = "QB";
                    break;
                }
                case "QB": {
                    const blocked = box("isTaskBlocked", () => isTaskBlocked(taskNumber, projectRoot)).blocked;
                    if (blocked) return runExitChain("blocked", "an open blocker remains");
                    node = "Q1";
                    break;
                }
                case "Q1": {
                    const existing = box("doesTaskWorktreeExist", () => doesTaskWorktreeExist(taskNumber, projectRoot));
                    if (!existing.exists || existing.worktree === null) { node = "NEW"; break; }
                    outcome.worktree = existing.worktree;
                    outcome.branch = taskBranchName(taskNumber);
                    node = "QS";
                    break;
                }
                case "NEW": {
                    const created = box("createTaskWorktree", () => createTaskWorktree(taskNumber, runId, projectRoot));
                    outcome.worktree = created.worktree;
                    outcome.branch = created.branch;
                    node = "GEN";
                    break;
                }
                case "GEN": {
                    box("generateTaskDocs", () => generateTaskDocs(taskNumber, outcome.worktree!, projectRoot));
                    node = "AMD";
                    break;
                }
                case "AMD": {
                    node = "INIT";
                    break;
                }
                case "QS": {
                    const safety = box("checkTaskWorktreeSafe", () => checkTaskWorktreeSafe(taskNumber, outcome.worktree!));
                    // The existing-worktree path always adopts the lease before any docs box, on both edges: without it the later clean-up hits an owner mismatch. The diagram only draws the resumable question on the unsafe edge, and only that edge branches on the answer.
                    const resumable = box("isTaskRunResumable",
                        () => isTaskRunResumable(taskNumber, outcome.worktree!, runId, projectRoot));
                    outcome.resumable = resumable.resumable;
                    if (!safety.safe && !resumable.resumable) { node = "RESET"; break; }
                    node = "UPD";
                    break;
                }
                case "RESET": {
                    const reset = box("resetTaskWorktree", () => resetTaskWorktree(taskNumber, runId, projectRoot));
                    outcome.worktree = reset.worktree;
                    outcome.branch = reset.branch;
                    node = "GEN";
                    break;
                }
                case "UPD": {
                    options.beforeUpdateTaskDocs?.(contextOf(), outcome.resumable === true);
                    box("updateTaskDocs", () => updateTaskDocs(taskNumber, outcome.worktree!, projectRoot));
                    node = "INIT";
                    break;
                }
                case "INIT": {
                    box("initTaskSubmodules", () => initTaskSubmodules({
                        worktreePath: outcome.worktree!, taskNumber, runId, projectRoot,
                        stepId: nextStepId("initTaskSubmodules"),
                    }));
                    node = "P";
                    break;
                }
                case "P": {
                    prose.planTheTask(contextOf(), planAttempts);
                    planAttempts += 1;
                    node = "VALP";
                    break;
                }
                case "VALP": {
                    const validation = box("validatePlanFile", () => validatePlanFile({
                        projectRoot, planFilePath: planFilePathOf(contextOf()), taskNumber,
                    }));
                    if (!validation.valid) { node = "QR_SCRAP"; break; }
                    node = "R";
                    break;
                }
                case "R": {
                    prose.codexReviewsThePlan(contextOf(), planAttempts - 1);
                    node = "VALR";
                    break;
                }
                case "VALR": {
                    const review = box("validateCodexReview", () => validateCodexReview({
                        projectRoot, reviewFilePath: reviewFilePathOf(contextOf()),
                    }));
                    if (!review.valid || review.verdict === "scrap") { node = "QR_SCRAP"; break; }
                    node = "AM";
                    break;
                }
                case "QR_SCRAP": {
                    planScraps += 1;
                    if (planScraps >= MAX_ATTEMPTS) return runExitChain("plan-scrapped", "codex scrapped the plan twice");
                    node = "P";
                    break;
                }
                case "AM": {
                    const applied = box("applyPlanAmendments", () => runApplyPlanAmendmentsCli({
                        projectRoot, planFilePath: planFilePathOf(contextOf()),
                        reviewFilePath: reviewFilePathOf(contextOf()), taskNumber,
                    }));
                    if (applied.status !== "applied") { node = "QR_SCRAP"; break; }
                    node = "A";
                    break;
                }
                case "A": {
                    const notesFile = prose.implementTask(contextOf());
                    if (notesFile !== null) {
                        box("recordImplementationNotes", () => recordImplementationNotes(
                            taskNumber, outcome.worktree!, notesFile, runId, projectRoot,
                        ));
                    }
                    node = "CW";
                    break;
                }
                case "CW": {
                    box("commitTaskWork", () => commitTaskWork({
                        projectRoot, worktreePath: outcome.worktree!, taskNumber, runId,
                        stepId: nextStepId("commitTaskWork"), rootSourceBranch: sourceBranch,
                    }));
                    node = "TT";
                    break;
                }
                case "TT": {
                    const taskTests = box("runTaskTests", () => runTaskTests(
                        taskNumber, runId, outcome.worktree!, nextStepId("runTaskTests"), projectRoot,
                    ));
                    if (!taskTests.passed) {
                        if (testFixes >= MAX_ATTEMPTS) {
                            return runExitChain("tests-red", "task tests failed after 2 codebase fixes");
                        }
                        prose.fixTheCodebaseForTaskTests(contextOf(), testFixes);
                        testFixes += 1;
                        node = "CW";
                        break;
                    }
                    node = "RT";
                    break;
                }
                case "RT": {
                    const verdict = prose.codexReviewsTests(contextOf(), testAmendments);
                    if (verdict === "flagged") {
                        if (testAmendments >= MAX_ATTEMPTS) {
                            return runExitChain("tests-flagged", "codex flagged the tests twice");
                        }
                        prose.amendTheTests(contextOf(), testAmendments);
                        testAmendments += 1;
                        node = "CW";
                        break;
                    }
                    node = "RB";
                    break;
                }
                case "RB": {
                    const rebase = await asyncBox("rebaseTaskWorktree", () => rebaseTaskWorktree({
                        projectRoot, worktreePath: outcome.worktree!, taskNumber, runId,
                        stepId: nextStepId("rebaseTaskWorktree"), rootSourceBranch: sourceBranch,
                    }, options.lockOptions));
                    // Phase 10: a warm held lock logs the holder and re-enters this box; only a recoverable (cold) lock takes the ordinary run-failed exit.
                    if (rebase.lock === "held") {
                        heldLockVisits += 1;
                        options.onHeldSourceLock?.(rebase.heldByOwner, heldLockVisits);
                        if (heldLockVisits > MAX_HELD_LOCK_REENTRIES) {
                            return runExitChain("run-failed", `the source lock stayed held by ${rebase.heldByOwner}`);
                        }
                        node = "RB";
                        break;
                    }
                    if (rebase.lock === "recoverable") {
                        return runExitChain(
                            "run-failed",
                            `the source lock is stale, owned by ${rebase.heldByOwner}; run ${rebase.recoveryCommand}`,
                        );
                    }
                    stoppedAt = rebase.stoppedAt;
                    conflictedFilePaths = rebase.conflictedFilePaths;
                    if (rebase.failureReason !== null && !rebase.conflicted) {
                        // Phase 8: the rebase helper's own tests-failed is a red full suite.
                        if (isTestsFailedReason(rebase.failureReason)) { node = "QF_RED"; break; }
                        return runExitChain("run-failed", rebase.failureReason);
                    }
                    node = rebase.conflicted ? "QC_CONFLICT" : "CS";
                    break;
                }
                case "QC_CONFLICT": {
                    if (conflictFixes >= MAX_ATTEMPTS) {
                        return runExitChain("rebase-stuck", "the rebase did not advance after 2 conflict fixes");
                    }
                    prose.fixConflicts(contextOf(), conflictedFilePaths, conflictFixes);
                    conflictFixes += 1;
                    node = "CS";
                    break;
                }
                case "CS": {
                    box("commitTaskWork", () => commitTaskWork({
                        projectRoot, worktreePath: outcome.worktree!, taskNumber, runId,
                        stepId: nextStepId("commitTaskWork"), rootSourceBranch: sourceBranch,
                    }));
                    node = stoppedAt === null ? "FULL" : "ADV";
                    break;
                }
                case "ADV": {
                    const advanced = box("advanceTaskRebase", () => advanceTaskRebase({
                        projectRoot, worktreePath: outcome.worktree!, taskNumber, runId,
                        stepId: nextStepId("advanceTaskRebase"), rootSourceBranch: sourceBranch,
                        stoppedAt: stoppedAt!,
                    }));
                    if (advanced.failureReason !== null && !advanced.conflicted) {
                        // Phase 8: the rebase helper's own tests-failed is a red full suite.
                        if (isTestsFailedReason(advanced.failureReason)) { node = "QF_RED"; break; }
                        return runExitChain("run-failed", advanced.failureReason);
                    }
                    if (advanced.conflicted) {
                        stoppedAt = advanced.stoppedAt;
                        conflictedFilePaths = advanced.conflictedFilePaths;
                        node = "QC_CONFLICT";
                        break;
                    }
                    if (!advanced.finished && advanced.stoppedAt !== null) { stoppedAt = advanced.stoppedAt; node = "ADV"; break; }
                    stoppedAt = null;
                    node = "FULL";
                    break;
                }
                case "FULL": {
                    const suite = box("runFullSuite", () => runFullSuite(
                        taskNumber, runId, outcome.worktree!, sourceBranch, nextStepId("runFullSuite"), projectRoot,
                    ));
                    if (!suite.passed) { node = "QF_RED"; break; }
                    node = "QFENCE";
                    break;
                }
                case "QF_RED": {
                    if (suiteFixes >= MAX_ATTEMPTS) {
                        return runExitChain("suite-red", "full suite still failing after 2 codebase fixes");
                    }
                    prose.fixTheCodebaseForTheSuite(contextOf(), suiteFixes);
                    suiteFixes += 1;
                    node = "CS";
                    break;
                }
                case "QFENCE": {
                    const fence = box("checkTaskFileFence", () => checkTaskFileFence({
                        projectRoot, worktreePath: outcome.worktree!, taskNumber, runId, rootSourceBranch: sourceBranch,
                    }));
                    if (!fence.inside) {
                        return runExitChain("fence-violation", "a step changed a file the task does not own");
                    }
                    node = "B";
                    break;
                }
                case "B": {
                    const merge = box("mergeTaskWorktree", () => forcedMergeOutcomes.shift() ?? mergeTaskWorktree({
                        projectRoot, worktreePath: outcome.worktree!, taskNumber, runId, rootSourceBranch: sourceBranch,
                    }));
                    if (!merge.merged) {
                        mergeAttempts += 1;
                        if (mergeAttempts >= MAX_ATTEMPTS) {
                            return runExitChain("merge-failed", "the merge did not land twice");
                        }
                        node = "RB";
                        break;
                    }
                    box("recordMergeCommits", () => recordMergeCommits({
                        projectRoot, taskNumber, runId, commits: merge.commits,
                    }));
                    node = "DONE";
                    break;
                }
                case "DONE": {
                    box("writeTaskExitNotes", () => writeTaskExitNotes({
                        taskNumber, runId, projectRoot, exitType: "completed", exitNote: "the task is done",
                    }));
                    box("recordTaskModifiedFiles", () => recordTaskModifiedFiles({
                        taskNumber, runId, projectRoot, worktree: outcome.worktree, sourceBranch,
                    }));
                    box("markTaskInactive", () => markTaskInactive({ taskNumber, runId, projectRoot }));
                    ended = true;
                    outcome.exitType = "completed";
                    outcome.exitNote = "the task is done";
                    if (options.stopAfterInactivation === true) return outcome;
                    node = "CLEAN";
                    break;
                }
                case "CLEAN": {
                    box("cleanupTaskWorktree", () => cleanupTaskWorktree({
                        projectRoot, worktreePath: outcome.worktree!, taskNumber, runId,
                    }));
                    node = "VNOTES";
                    break;
                }
                case "VNOTES": {
                    outcome.closureNote = box("buildClosureNote",
                        () => buildClosureNote({ taskNumber, runId, projectRoot })).closureNote;
                    node = "ARCH";
                    break;
                }
                case "ARCH": {
                    options.beforeArchive?.(projectRoot);
                    const stepId = nextStepId("closeTaskRun");
                    const stepInput = {
                        taskNumber, runId, projectRoot, closureNote: outcome.closureNote!, stepId,
                    };
                    if (options.loseCloseResult === true) {
                        // Rule 11: the box runs and mutates; its stdout is lost, so the read-only reconciliation check decides which edge the run takes.
                        box("closeTaskRun", () => closeTaskRun(stepInput));
                        const reconciled = box("reconcileStep", () => reconcileStep({
                            script: "closeTaskRun", stepId, taskNumber, runId, projectRoot,
                            stepInput: { ...stepInput },
                        }));
                        if (reconciled.status !== "completed") {
                            return reopenEndedRunAsFailed(`the archive could not be reconciled: ${reconciled.note}`);
                        }
                        outcome.closeOutput = reconciled.result as unknown as CloseTaskRunOutput;
                        return outcome;
                    }
                    outcome.closeOutput = box("closeTaskRun", () => closeTaskRun(stepInput));
                    if (!outcome.closeOutput.closed.includes(taskNumber)) {
                        return reopenEndedRunAsFailed("the archive did not close the task");
                    }
                    return outcome;
                }
                default:
                    throw new Error(`unknown diagram node "${node}"`);
            }
        }
    } catch (error) {
        // Rule 10, in its four cases.
        const note = error instanceof OperationalFailure ? error.message : `${(error as Error).message}`;
        if (!claimed) {
            outcome.exitType = "run-failed";
            outcome.exitNote = note;
            return outcome;
        }
        if (ended) return reopenEndedRunAsFailed(note);
        return runExitChain("run-failed", note);
    }

    // Rule 10, fourth case: the run already ended, so the chain reopens it, overwrites exit type completed with run-failed, and re-ends it — that whole transition is writeTaskExitNotes's reopen mode, so the chain's record/inactivate boxes do not run again on an ended run.
    function reopenEndedRunAsFailed(exitNote: string): PipelineOutcome {
        box("writeTaskExitNotes", () => writeTaskExitNotes({
            taskNumber, runId, projectRoot, exitType: "run-failed", exitNote, reopen: true,
        }));
        box("releaseTaskRunHolds", () => releaseTaskRunHolds({
            taskNumber, runId, projectRoot, worktree: outcome.worktree, branchName: outcome.branch,
            stepId: nextStepId("releaseTaskRunHolds"),
        }));
        outcome.exitType = "run-failed";
        outcome.exitNote = exitNote;
        return outcome;
    }
}

// --- assertion helpers ----------------------------------------------------------------------

// A completed run is archived out of tasks.json, so its state is read from whichever task file still holds the task.
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

// The two durable holds a run must not leak: the source repository lock and the worktree lease.
function assertHoldsAreFree(projectRoot: string, taskNumber: number, outcome: PipelineOutcome): void {
    const lock = readSourceRepoLock(projectRoot);
    const owner = buildLockOwner(outcome.runId, taskNumber);
    assert.ok(lock === null || lock.owner !== owner, `the source lock is still owned by ${owner}`);
    if (outcome.worktree === null) return;
    const leasePath = taskWorktreeLeasePath(outcome.worktree);
    if (!existsSync(leasePath)) return;
    // A retained lease is legal only while the worktree it protects still exists.
    assert.ok(existsSync(outcome.worktree), "a worktree lease outlived its worktree");
}

function assertVisitedInOrder(visited: string[], expected: string[]): void {
    let cursor = 0;
    for (const name of expected) {
        const found = visited.indexOf(name, cursor);
        assert.ok(found !== -1, `green box "${name}" was never visited, in order, in: ${visited.join(" -> ")}`);
        cursor = found + 1;
    }
}

// --- the tests ------------------------------------------------------------------------------

test("test_pipeline_claimsTheTaskThenReleasesItAcrossASuccessfulRun", async () => {
    // Setup: a real repo with a real submodule and one open task inside its own fence.
    const projectRoot = makeSourceRepository("pipeline-claim");
    seedTask(projectRoot, 1, FENCE_INSIDE(1));

    // Test action: drive the whole diagram.
    const outcome = await runPipeline({
        projectRoot, taskNumber: 1, prose: { implementTask: implementInsideTheFence },
    });

    // Verification: the run claimed the task, finished completed, and left nothing held.
    assert.equal(outcome.claimStatus, "claimed");
    assert.equal(outcome.exitType, "completed", outcome.exitNote);
    assert.equal(runStateOf(projectRoot, 1).active, false);
    assert.ok(!existsSync(outcome.worktree!), "the worktree survived the run");
    assert.ok(!existsSync(taskWorktreeLeasePath(outcome.worktree!)), "the worktree lease survived the run");
    assert.equal(readSourceRepoLock(projectRoot), null);

    // Verification: every green box on the fresh-worktree success path ran, in diagram order.
    assertVisitedInOrder(outcome.visited, [
        "isTaskNumberValid", "isTaskActive", "isTaskBlocked", "doesTaskWorktreeExist",
        "createTaskWorktree", "generateTaskDocs", "initTaskSubmodules",
        "validatePlanFile", "validateCodexReview", "applyPlanAmendments", "recordImplementationNotes",
        "commitTaskWork", "runTaskTests", "rebaseTaskWorktree", "commitTaskWork", "runFullSuite",
        "checkTaskFileFence", "mergeTaskWorktree", "recordMergeCommits", "writeTaskExitNotes",
        "recordTaskModifiedFiles", "markTaskInactive", "cleanupTaskWorktree", "buildClosureNote",
        "closeTaskRun",
    ]);
    // Verification: the fresh-worktree path never entered the existing-worktree branch.
    assert.ok(!outcome.visited.includes("updateTaskDocs"));
    assert.ok(!outcome.visited.includes("resetTaskWorktree"));
});

test("test_pipeline_archivesTheTaskWithEveryCommitIncludingSubmoduleOnes", async () => {
    // Setup: a task whose file changes span the root and the real submodule.
    const projectRoot = makeSourceRepository("pipeline-archive");
    seedTask(projectRoot, 2, FENCE_INSIDE(2));

    // Test action: drive the whole diagram.
    const outcome = await runPipeline({
        projectRoot, taskNumber: 2, prose: { implementTask: implementInsideTheFence },
    });

    // Verification: the task is archived, and its recorded commits cover the submodule occurrence as well as the root, with the published merge commits last.
    assert.equal(outcome.exitType, "completed", outcome.exitNote);
    assert.deepEqual(outcome.closeOutput?.closed, [2]);
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    const openTasks = JSON.parse(readFileSync(tasksPath, "utf8")) as { taskNumber: number }[];
    const archived = JSON.parse(readFileSync(completedTasksPath, "utf8")) as { taskNumber: number }[];
    assert.ok(!openTasks.some((task) => task.taskNumber === 2));
    assert.equal(archived.filter((task) => task.taskNumber === 2).length, 1);
    const commits = newestRun(projectRoot, 2).commits;
    assert.ok(commits.some((commit) => commit.occurrenceId === "child"), "no submodule commit was recorded");
    assert.ok(commits.some((commit) => commit.occurrenceId === ""), "no root commit was recorded");
    assert.ok(commits.some((commit) => commit.kind === "merge"), "no merge commit was recorded");
    assert.equal(commits[commits.length - 1].kind, "merge");
});

test("test_pipeline_writesExitTypeAndExitNotesWhenTheSuiteStaysRed", async () => {
    // Setup: a task whose declared change breaks a seed test its own test box never runs, and a repair box that never repairs it.
    const projectRoot = makeSourceRepository("pipeline-suite-red");
    seedTask(projectRoot, 3, FENCE_WITH_VALUE(3));

    // Test action: drive the diagram until the suite loop gives up.
    const outcome = await runPipeline({
        projectRoot, taskNumber: 3, prose: { implementTask: implementAndBreakTheSuite },
    });

    // Verification: the run exited suite-red only after two repair attempts, and both fields are on the record.
    assert.equal(outcome.exitType, "suite-red", outcome.exitNote);
    const record = newestRun(projectRoot, 3);
    assert.equal(record.exitType, "suite-red");
    assert.equal(record.exitNote, "full suite still failing after 2 codebase fixes");
    // The task's own test box was green: only the wider suite went red.
    assert.equal(record.taskTests?.passed, true);
    // Rule 6: every repair re-enters at "commit if needed", never at the test box.
    const commitCount = outcome.visited.filter((name) => name === "commitTaskWork").length;
    assert.ok(commitCount >= 3, `expected a commit before each repair, saw ${commitCount}`);
});

// Every diagram exit that runs the common state-writing exit chain, driven end to end.
type ExitScenario = {
    exitType: string;
    exitNote: string;
    taskNumber: number;
    afterLock: boolean;
    build: (projectRoot: string) => void;
    options: (projectRoot: string) => PipelineOptions;
};

const EXIT_SCENARIOS: ExitScenario[] = [
    {
        exitType: "blocked", exitNote: "an open blocker remains", taskNumber: 30, afterLock: false,
        build: (projectRoot) => seedTaskFiles(projectRoot, [
            { taskNumber: 30, title: "task 30", description: "do it", files: FENCE_INSIDE(30),
              blockedBy: [{ taskNum: 99, reason: "task 99 is still open" }] },
            { taskNumber: 99, title: "task 99", description: "the blocker", files: [] },
        ]),
        options: (projectRoot) => ({ projectRoot, taskNumber: 30, prose: { implementTask: implementInsideTheFence } }),
    },
    {
        exitType: "plan-scrapped", exitNote: "codex scrapped the plan twice", taskNumber: 31, afterLock: false,
        build: (projectRoot) => seedTask(projectRoot, 31, FENCE_INSIDE(31)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 31,
            prose: {
                implementTask: implementInsideTheFence,
                codexReviewsThePlan: (context) => writeJsonFile(reviewFilePathOf(context), {
                    verdict: "scrap", notes: "start over",
                }),
            },
        }),
    },
    {
        exitType: "tests-red", exitNote: "task tests failed after 2 codebase fixes", taskNumber: 32, afterLock: false,
        build: (projectRoot) => seedTask(projectRoot, 32, FENCE_INSIDE(32)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 32, prose: { implementTask: implementWithARedTaskTest },
        }),
    },
    {
        exitType: "tests-flagged", exitNote: "codex flagged the tests twice", taskNumber: 33, afterLock: false,
        build: (projectRoot) => seedTask(projectRoot, 33, FENCE_INSIDE(33)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 33,
            prose: { implementTask: implementInsideTheFence, codexReviewsTests: () => "flagged" },
        }),
    },
    {
        exitType: "rebase-stuck", exitNote: "the rebase did not advance after 2 conflict fixes",
        taskNumber: 34, afterLock: true,
        build: (projectRoot) => seedTask(projectRoot, 34, [...FENCE_INSIDE(34), "contested.txt"]),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 34,
            prose: {
                // Three task commits touch the same line the source branch then moves, so every advance stops on a fresh conflict and the loop really runs out of attempts.  (Committing a conflicted layer is what resolves one replayed commit, so a single conflicting commit would let the rebase finish.)
                implementTask: (context) => {
                    const notes = implementInsideTheFence(context);
                    for (const line of ["task line one", "task line two"]) {
                        writeFileSync(join(context.worktreePath, "contested.txt"), `${line}\n`);
                        git(context.worktreePath, "add", "contested.txt");
                        git(context.worktreePath, "commit", "-q", "-m", line);
                    }
                    writeFileSync(join(context.worktreePath, "contested.txt"), "task line three\n");
                    advanceSourceRootBranch(context.projectRoot, "source line\n");
                    return notes;
                },
            },
        }),
    },
    {
        exitType: "suite-red", exitNote: "full suite still failing after 2 codebase fixes",
        taskNumber: 35, afterLock: true,
        build: (projectRoot) => seedTask(projectRoot, 35, FENCE_WITH_VALUE(35)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 35, prose: { implementTask: implementAndBreakTheSuite },
        }),
    },
    {
        exitType: "merge-failed", exitNote: "the merge did not land twice", taskNumber: 36, afterLock: true,
        build: (projectRoot) => seedTask(projectRoot, 36, FENCE_INSIDE(36)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 36, prose: { implementTask: implementInsideTheFence },
            // A real merge cannot conflict after a clean rebase while the source tip guard holds, so the two failed landings are forced. Everything around them is the real pipeline, including the rebase-and-retry edge between them.
            forcedMergeOutcomes: [
                { merged: false, commits: [], failureReason: "submodule-conflicted" },
                { merged: false, commits: [], failureReason: "submodule-conflicted" },
            ],
        }),
    },
    {
        exitType: "fence-violation", exitNote: "a step changed a file the task does not own",
        taskNumber: 37, afterLock: true,
        build: (projectRoot) => seedTask(projectRoot, 37, FENCE_INSIDE(37)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 37, prose: { implementTask: implementOutsideTheFence },
        }),
    },
    {
        exitType: "run-failed", exitNote: "isTaskBlocked failed operationally", taskNumber: 38, afterLock: false,
        build: (projectRoot) => seedTask(projectRoot, 38, FENCE_INSIDE(38)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 38, prose: { implementTask: implementInsideTheFence }, failAt: "isTaskBlocked",
        }),
    },
    {
        exitType: "run-failed", exitNote: "commitTaskWork failed operationally", taskNumber: 39, afterLock: false,
        build: (projectRoot) => seedTask(projectRoot, 39, FENCE_INSIDE(39)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 39, prose: { implementTask: implementInsideTheFence }, failAt: "commitTaskWork",
        }),
    },
    {
        exitType: "run-failed", exitNote: "cleanupTaskWorktree failed operationally", taskNumber: 40, afterLock: true,
        build: (projectRoot) => seedTask(projectRoot, 40, FENCE_INSIDE(40)),
        options: (projectRoot) => ({
            projectRoot, taskNumber: 40, prose: { implementTask: implementInsideTheFence }, failAt: "cleanupTaskWorktree",
        }),
    },
];

test("test_pipeline_leavesTheTaskInactiveAfterEveryExitPathThatWritesState", async () => {
    for (const scenario of EXIT_SCENARIOS) {
        // Setup: one real repository per exit.
        const projectRoot = makeSourceRepository(`pipeline-inactive-${scenario.taskNumber}`);
        scenario.build(projectRoot);

        // Test action: drive the diagram to this exit.
        const outcome = await runPipeline(scenario.options(projectRoot));

        // Verification: the exact exit type and note, and an inactive task.
        assert.equal(outcome.exitType, scenario.exitType, `task ${scenario.taskNumber}: ${outcome.exitNote}`);
        assert.equal(outcome.exitNote, scenario.exitNote, `task ${scenario.taskNumber}`);
        const record = newestRun(projectRoot, scenario.taskNumber);
        assert.equal(record.exitType, scenario.exitType, `task ${scenario.taskNumber} record`);
        assert.equal(record.exitNote, scenario.exitNote, `task ${scenario.taskNumber} record`);
        assert.equal(runStateOf(projectRoot, scenario.taskNumber).active, false, `task ${scenario.taskNumber} active`);
    }

    // Setup: one repository holding an active run of task 50 and an archived task 51, so the non-writing exit that is reachable here can be checked against a live neighbouring run.
    const quietRoot = makeSourceRepository("pipeline-non-writing-exits");
    seedTaskFiles(quietRoot, [{ taskNumber: 50, title: "task 50", description: "do it", files: FENCE_INSIDE(50) }]);
    writeJsonAtomically(resolveTaskFiles(quietRoot).completedTasksPath, [{ taskNumber: 51, title: "task 51" }]);
    assert.equal(isTaskActive(50, "run-live", quietRoot).status, "claimed");
    const liveStateBefore = JSON.stringify(readTaskRunState(50, quietRoot));

    // Test action: drive the non-writing exit, once for a number in no file and once for a number only in completedTasks.json — being archived is not being valid.
    const invalidNumber = await runPipeline({ projectRoot: quietRoot, taskNumber: 52 });
    const archived = await runPipeline({ projectRoot: quietRoot, taskNumber: 51 });

    // Verification: neither ran the exit chain, and neither touched the live run's state.
    assert.equal(invalidNumber.exitType, "invalid-number");
    assert.equal(archived.exitType, "invalid-number");
    for (const outcome of [invalidNumber, archived]) {
        assert.ok(!outcome.visited.includes("writeTaskExitNotes"), "a non-writing exit ran the exit chain");
        assert.ok(!outcome.visited.includes("markTaskInactive"), "a non-writing exit ran the exit chain");
    }
    assert.equal(JSON.stringify(readTaskRunState(50, quietRoot)), liveStateBefore);
});

test("test_pipeline_releasesTheSourceLockOnEveryExitPath", async () => {
    for (const scenario of EXIT_SCENARIOS) {
        // Setup: one real repository per exit.
        const projectRoot = makeSourceRepository(`pipeline-lock-${scenario.taskNumber}`);
        scenario.build(projectRoot);

        // Test action: drive the diagram to this exit.
        const outcome = await runPipeline(scenario.options(projectRoot));

        // Verification: neither durable hold is still owned by this run.
        assert.equal(outcome.exitType, scenario.exitType, `task ${scenario.taskNumber}: ${outcome.exitNote}`);
        assertHoldsAreFree(projectRoot, scenario.taskNumber, outcome);
    }

    // Setup + test action: a successful run, which releases both holds in clean-up instead.
    const completedRoot = makeSourceRepository("pipeline-lock-completed");
    seedTask(completedRoot, 41, FENCE_INSIDE(41));
    const completed = await runPipeline({
        projectRoot: completedRoot, taskNumber: 41, prose: { implementTask: implementInsideTheFence },
    });

    // Verification: the success path leaves nothing held either.
    assert.equal(completed.exitType, "completed", completed.exitNote);
    assert.equal(readSourceRepoLock(completedRoot), null);
});

test("test_pipeline_refusesASecondConcurrentRunOfTheSameTask", async () => {
    // Setup: a task already claimed by a first run that has not ended.
    const projectRoot = makeSourceRepository("pipeline-concurrent");
    seedTask(projectRoot, 11, FENCE_INSIDE(11));
    const first = isTaskActive(11, "run-first", projectRoot);

    // Test action: a second invocation drives the diagram from its first box.
    const second = await runPipeline({
        projectRoot, taskNumber: 11, runId: "run-second", prose: { implementTask: implementInsideTheFence },
    });

    // Verification: the second run is refused at the claim, exits already-active, and writes nothing to the first run's record.
    assert.equal(first.status, "claimed");
    assert.equal(second.claimStatus, "refused");
    assert.equal(second.exitType, "already-active");
    assert.ok(!second.visited.includes("writeTaskExitNotes"), "a non-writing exit ran the exit chain");
    const state = readTaskRunState(11, projectRoot);
    assert.equal(state.active, true);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].runId, "run-first");
    assert.equal(state.history[0].exitType, null);
});

test("test_pipeline_refusesASecondClaimBetweenInactivationAndArchive", async () => {
    // Setup: a successful run stopped right after mark task inactive, before the archive.
    const projectRoot = makeSourceRepository("pipeline-closing");
    seedTask(projectRoot, 12, FENCE_INSIDE(12));
    const outcome = await runPipeline({
        projectRoot, taskNumber: 12, prose: { implementTask: implementInsideTheFence }, stopAfterInactivation: true,
    });

    // Test action: a second invocation tries to claim the still-open, now-inactive task.
    const second = isTaskActive(12, "run-second", projectRoot);

    // Verification: the claim reports closing, distinct from refused (diagram rule 12).
    assert.equal(outcome.exitType, "completed", outcome.exitNote);
    assert.equal(readTaskRunState(12, projectRoot).active, false);
    assert.equal(second.status, "closing");
});

test("test_pipeline_reportsRunFailedWhenArchiveFailsAfterInactivation", async () => {
    // Setup: an archived record for the same task under a different run lands before the archive box, so closing the open record cannot be reconciled.
    const projectRoot = makeSourceRepository("pipeline-archive-fails");
    seedTask(projectRoot, 13, FENCE_INSIDE(13));

    // Test action: drive the diagram, poisoning the archive just before its box runs.
    const outcome = await runPipeline({
        projectRoot,
        taskNumber: 13,
        prose: { implementTask: implementInsideTheFence },
        beforeArchive: (root) => writeJsonAtomically(resolveTaskFiles(root).completedTasksPath, [
            { taskNumber: 13, title: "task 13", run: { active: false, worktree: null, leaseRunId: null, history: [] } },
        ]),
    });

    // Verification: rule 10's fourth case — the already-ended record was reopened as run-failed rather than left claiming it completed, and re-ended.
    assert.equal(outcome.exitType, "run-failed", outcome.exitNote);
    const record = newestRun(projectRoot, 13);
    assert.equal(record.exitType, "run-failed");
    assert.ok(record.endedAt !== null, "the reopened run was never re-ended");
    assert.equal(readTaskRunState(13, projectRoot).active, false);
});

test("test_pipeline_recognizesACompletedArchiveWhenTheResultIsLost", async () => {
    // Setup: a task whose archive box will mutate and then lose its result.
    const projectRoot = makeSourceRepository("pipeline-lost-archive");
    seedTask(projectRoot, 14, FENCE_INSIDE(14));

    // Test action: drive the diagram with the archive result thrown away, so the read-only reconciliation check has to decide the edge (rule 11).
    const outcome = await runPipeline({
        projectRoot, taskNumber: 14, prose: { implementTask: implementInsideTheFence }, loseCloseResult: true,
    });

    // Verification: reconciliation reconstructed the close result and the run finished completed,
    // without reopening it as run-failed.
    assert.ok(outcome.visited.includes("reconcileStep"), "the lost result never reached reconciliation");
    assert.equal(outcome.exitType, "completed", outcome.exitNote);
    assert.deepEqual(outcome.closeOutput?.closed, [14]);
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    const openTasks = JSON.parse(readFileSync(tasksPath, "utf8")) as { taskNumber: number }[];
    const archived = JSON.parse(readFileSync(completedTasksPath, "utf8")) as { taskNumber: number }[];
    assert.ok(!openTasks.some((task) => task.taskNumber === 14), "the task is still open after a landed archive");
    assert.equal(archived.filter((task) => task.taskNumber === 14).length, 1);
    assert.equal(newestRun(projectRoot, 14).exitType, "completed");
});

test("test_pipeline_resumesAPreviousRunAndAdoptsItsWorktreeLease", async () => {
    // Setup: a first run that recorded real implementation notes, then exited suite-red and left its safe worktree and its own physical lease behind.
    const projectRoot = makeSourceRepository("pipeline-resume");
    seedTask(projectRoot, 15, FENCE_WITH_VALUE(15));
    const first = await runPipeline({
        projectRoot, taskNumber: 15, runId: "run-first", prose: { implementTask: implementAndBreakTheSuite },
    });
    assert.equal(first.exitType, "suite-red", first.exitNote);
    assert.ok(existsSync(first.worktree!), "the first run did not retain its worktree");
    assert.equal(newestRun(projectRoot, 15).implementationNotesFile !== null, true);
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(first.worktree!))?.runId, "run-first");

    // Test action: a second run drives the complete diagram, entering the existing-worktree path.
    let leaseAtUpdateDocs: string | null = null;
    let stateLeaseAtUpdateDocs: string | null = null;
    let resumableAtUpdateDocs: boolean | null = null;
    const second = await runPipeline({
        projectRoot, taskNumber: 15, runId: "run-second",
        prose: { implementTask: implementAndRepairTheSuite },
        beforeUpdateTaskDocs: (context, resumable) => {
            leaseAtUpdateDocs = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(context.worktreePath))?.runId ?? null;
            stateLeaseAtUpdateDocs = readTaskRunState(15, projectRoot).leaseRunId;
            resumableAtUpdateDocs = resumable;
        },
    });

    // Verification: it reused the first run's worktree, both leases named the second run before the docs box, and the run finished completed with every hold released.
    assert.equal(second.worktree, first.worktree);
    assertVisitedInOrder(second.visited, [
        "doesTaskWorktreeExist", "checkTaskWorktreeSafe", "isTaskRunResumable", "updateTaskDocs",
        "initTaskSubmodules", "commitTaskWork", "runFullSuite", "mergeTaskWorktree", "cleanupTaskWorktree",
        "closeTaskRun",
    ]);
    assert.ok(!second.visited.includes("createTaskWorktree"), "the second run built a new worktree");
    // The prior run recorded where it stopped, so its work really is resumable.
    assert.equal(resumableAtUpdateDocs, true);
    assert.equal(second.resumable, true);
    assert.equal(leaseAtUpdateDocs, "run-second");
    assert.equal(stateLeaseAtUpdateDocs, "run-second");
    assert.equal(second.exitType, "completed", second.exitNote);
    assert.ok(!existsSync(first.worktree!), "the retained worktree survived the resumed run");
    assert.ok(!existsSync(taskWorktreeLeasePath(first.worktree!)), "the retained lease survived the resumed run");
    assert.equal(readSourceRepoLock(projectRoot), null);
});

test("test_pipeline_waitsOutAWarmSourceLockHeldByAnotherRunAndThenCompletes", async () => {
    // Setup: a task ready to rebase, and a real warm source lock already held by another run.
    const projectRoot = makeSourceRepository("pipeline-warm-lock");
    seedTask(projectRoot, 19, FENCE_INSIDE(19));
    const otherOwner = buildLockOwner("run-other", 77);
    assert.equal(acquireSourceRepoLock(projectRoot, otherOwner).status, "acquired");

    // Test action: drive the diagram. The first real rebase call observes the warm lock; the held-lock callback releases the other owner, so the next visit can acquire it.
    let heldVisits = 0;
    const outcome = await runPipeline({
        projectRoot, taskNumber: 19, prose: { implementTask: implementInsideTheFence },
        lockOptions: { pollIntervalMs: 20, timeoutMs: 200 },
        onHeldSourceLock: (heldByOwner) => {
            heldVisits += 1;
            assert.equal(heldByOwner, otherOwner);
            releaseSourceRepoLock(projectRoot, otherOwner);
        },
    });

    // Verification: the held result re-entered the rebase box instead of exiting the run.
    assert.equal(heldVisits, 1);
    assert.ok(outcome.visited.filter((name) => name === "rebaseTaskWorktree").length >= 2,
        `expected the rebase box to be re-entered, saw: ${outcome.visited.join(" -> ")}`);
    assert.ok(!outcome.visited.includes("releaseTaskRunHolds"), "the held lock ran the exit chain");
    assert.equal(outcome.exitType, "completed", outcome.exitNote);
    assert.equal(readSourceRepoLock(projectRoot), null);
});

test("test_pipeline_exitsRunFailedWhenTheSourceLockIsColdAndRecoverable", async () => {
    // Setup: a task ready to rebase, and a real lock file whose heartbeat has gone cold.
    const projectRoot = makeSourceRepository("pipeline-cold-lock");
    seedTask(projectRoot, 20, FENCE_INSIDE(20));
    const staleOwner = buildLockOwner("run-crashed", 78);
    assert.equal(acquireSourceRepoLock(projectRoot, staleOwner).status, "acquired");
    const lockPath = join(projectRoot, ".git", "taskTools-source.lock");
    const coldAt = new Date(Date.now() - 2 * STALE_HEARTBEAT_MS).toISOString();
    writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(readFileSync(lockPath, "utf8")), heartbeatAt: coldAt }));

    // Test action: drive the diagram into the rebase box.
    const outcome = await runPipeline({
        projectRoot, taskNumber: 20, prose: { implementTask: implementInsideTheFence },
        lockOptions: { pollIntervalMs: 20, timeoutMs: 200 },
    });

    // Verification: a cold lock is run-failed, names the exact stale owner, and is never taken over — only the maintenance script may remove it.
    assert.equal(outcome.exitType, "run-failed");
    assert.ok(outcome.exitNote.includes(staleOwner), `exit note did not name the owner: ${outcome.exitNote}`);
    assert.ok(outcome.exitNote.includes("recoverSourceRepoLock"), `exit note gave no recovery command: ${outcome.exitNote}`);
    assert.equal(readSourceRepoLock(projectRoot)?.owner, staleOwner);
    assert.equal(runStateOf(projectRoot, 20).active, false);
});

test("test_pipeline_recordsASecondRunWithoutDestroyingTheFirstRunsHistory", async () => {
    // Setup: a first run that exits suite-red and leaves a durable record.
    const projectRoot = makeSourceRepository("pipeline-history");
    seedTask(projectRoot, 16, FENCE_WITH_VALUE(16));
    const first = await runPipeline({
        projectRoot, taskNumber: 16, prose: { implementTask: implementAndBreakTheSuite },
    });
    assert.equal(first.exitType, "suite-red", first.exitNote);

    // Test action: a second run of the same task that repairs the seed test it broke.
    const second = await runPipeline({
        projectRoot, taskNumber: 16, prose: { implementTask: implementAndRepairTheSuite },
    });

    // Verification: both runs are on the record, oldest first, with the first one untouched.
    assert.equal(second.exitType, "completed", second.exitNote);
    const history = runStateOf(projectRoot, 16).history;
    assert.equal(history.length, 2);
    assert.equal(history[0].runId, first.runId);
    assert.equal(history[0].exitType, "suite-red");
    assert.equal(history[1].runId, second.runId);
    assert.equal(history[1].exitType, "completed");
});

// Two real `createTaskWorktree.ts` CLIs in separate processes, each holding at a barrier file until both have started, so the contended section really overlaps.
const CONCURRENT_CREATE_RUNNER = `
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createTaskWorktree } from "SCRIPTS/createTaskWorktree.ts";

const [taskNumber, runId, projectRoot, barrierDirectory, label, otherLabel] = process.argv.slice(2);
mkdirSync(barrierDirectory, { recursive: true });
writeFileSync(\`\${barrierDirectory}/\${label}\`, "");
const deadline = Date.now() + 30000;
while (!existsSync(\`\${barrierDirectory}/\${otherLabel}\`)) {
    if (Date.now() > deadline) throw new Error("the other invocation never started");
}
const startedAt = Date.now();
const output = createTaskWorktree(Number(taskNumber), runId, projectRoot);
process.stdout.write(JSON.stringify({ ...output, startedAt, endedAt: Date.now() }) + "\\n");
`;

test("test_pipeline_runsTwoTaskWorktreeCreationsConcurrentlyWithoutInterference", async () => {
    // Setup: two open tasks in one real repository, each claimed by its own run.
    const projectRoot = makeSourceRepository("pipeline-concurrent-worktrees");
    seedTaskFiles(projectRoot, [
        { taskNumber: 17, title: "task 17", description: "do it", files: FENCE_INSIDE(17) },
        { taskNumber: 18, title: "task 18", description: "do it", files: FENCE_INSIDE(18) },
    ]);
    assert.equal(isTaskActive(17, "run-17", projectRoot).status, "claimed");
    assert.equal(isTaskActive(18, "run-18", projectRoot).status, "claimed");

    const scriptsDirectory = join(import.meta.dirname, "..", "scripts", "tackle-tasks");
    const runnerPath = join(projectRoot, "concurrent-create-runner.mjs");
    writeFileSync(runnerPath, CONCURRENT_CREATE_RUNNER.replaceAll("SCRIPTS", scriptsDirectory));
    const barrierDirectory = join(projectRoot, "concurrent-barrier");

    // Test action: run both real creations in separate processes, released together by a barrier.
    const [seventeen, eighteen] = await Promise.all([17, 18].map((taskNumber) => new Promise<{
        worktree: string; branch: string; startedAt: number; endedAt: number;
    }>((resolve, reject) => {
        const child = spawn("node", [
            runnerPath, String(taskNumber), `run-${taskNumber}`, projectRoot, barrierDirectory,
            `started-${taskNumber}`, `started-${taskNumber === 17 ? 18 : 17}`,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) { reject(new Error(`task ${taskNumber} creation exited ${code}: ${stderr}`)); return; }
            resolve(JSON.parse(stdout.trim().split("\n").pop()!));
        });
    })));

    // Verification: the two creations really overlapped in time.
    const overlaps = seventeen.startedAt <= eighteen.endedAt && eighteen.startedAt <= seventeen.endedAt;
    assert.ok(overlaps, "the two creations did not overlap, so no contention was exercised");

    // Verification: two distinct real worktrees, each on its own branch, each recorded on its own run.
    assert.notEqual(seventeen.worktree, eighteen.worktree);
    assert.ok(existsSync(join(seventeen.worktree, "child", "seed.txt")));
    assert.ok(existsSync(join(eighteen.worktree, "child", "seed.txt")));
    assert.equal(git(seventeen.worktree, "branch", "--show-current"), taskBranchName(17));
    assert.equal(git(eighteen.worktree, "branch", "--show-current"), taskBranchName(18));
    assert.equal(readTaskRunState(17, projectRoot).worktree, seventeen.worktree);
    assert.equal(readTaskRunState(18, projectRoot).worktree, eighteen.worktree);
});
