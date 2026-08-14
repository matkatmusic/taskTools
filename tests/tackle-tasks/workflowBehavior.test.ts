// Behavioural checks for skills/tackle-tasks/tackle-tasks.workflow.js.
// The workflow cannot be imported, so it is compiled in its sandbox shape and driven with a
// stub agent. Each test overrides only the boxes it is about; every other box answers happily.
// Run: node --test tests/tackle-tasks/workflowBehavior.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, "skills", "tackle-tasks", "tackle-tasks.workflow.js");
const workflowSource = readFileSync(workflowPath, "utf8").replace("export const meta", "const meta");

const TASK = 169;

const workflowArgs = {
    task: TASK,
    projectRoot: "/abs/repo",
    sourceBranch: "master",
    runId: "run-abc",
    scriptsDir: "/abs/repo/scripts/tackle-tasks",
    agentPromptEmitterPath: "/abs/repo/scripts/tackle-tasks/AgentPromptEmitter.ts",
};

type AgentOptions = { label: string; phase?: string; schema?: object };
type StubAgent = (prompt: string, options: AgentOptions) => Promise<unknown>;

// The box name is everything before the trailing ":<taskNumber>" in the label.
const boxOf = (label: string) => label.slice(0, label.lastIndexOf(":"));

// Every prompt carries its stdin payload inside one quoted heredoc.
const payloadOf = (prompt: string) => {
    const match = /<<'TASK_PAYLOAD'\n([\s\S]*?)\nTASK_PAYLOAD/.exec(prompt);
    assert.ok(match, "prompt carries no TASK_PAYLOAD heredoc");
    return JSON.parse(match[1]) as Record<string, unknown>;
};

// A run that reaches "completed" when nothing is overridden.
const happyResponses: Record<string, unknown> = {
    isTaskNumberValid: { valid: true, location: "open" },
    isTaskOpen: { open: true, closeInProgress: false },
    claimTaskRun: { status: "claimed", heldByRunId: null },
    isTaskBlocked: { blocked: false, blockers: [] },
    doesTaskWorktreeExist: { exists: false, worktree: null },
    createTaskWorktree: { worktree: "/abs/repo/.worktrees/task-169", branch: "task-169" },
    resetTaskWorktree: { worktree: "/abs/repo/.worktrees/task-169", branch: "task-169" },
    isTaskRunResumable: { resumable: false, implementationNotesFile: null, leaseEstablished: true },
    checkTaskWorktreeSafe: { safe: true, problems: [] },
    generateTaskDocs: { briefFile: "plans/brief-169.md" },
    updateTaskDocs: { briefFile: "plans/brief-169.md" },
    initTaskSubmodules: { initialized: true },
    plan: { planWritten: true },
    validatePlanFile: { valid: true, problem: null, sectionIds: ["one"] },
    "review-plan": { reviewWritten: true, reviewer: "codex" },
    validateCodexReview: { valid: true, problem: null, verdict: "amend", scrapNotes: null },
    applyPlanAmendments: { status: "applied", revision: 2, problem: null },
    implement: { implemented: true, implementationNotesFile: "plans/notes.md", remaining: [] },
    recordImplementationNotes: { implementationNotesFile: "plans/notes.md" },
    commitTaskWork: { commits: [] },
    runTaskTests: {
        stepId: "task-tests:1", passed: true, testFiles: [], createdTestFiles: [],
        deletedTestFiles: [], missingTests: false, output: "",
    },
    "review-tests": { flagged: false, reviewer: "codex" },
    "amend-tests": { amended: true },
    "fix-tests": { fixed: true },
    "fix-suite": { fixed: true },
    "fix-conflicts": { resolved: true, unresolvedPaths: [] },
    rebaseTaskWorktree: {
        lock: "acquired", heldByOwner: null, recoveryCommand: null, conflicted: false,
        stoppedAt: null, conflictedFilePaths: [], failureReason: null,
    },
    advanceTaskRebase: {
        finished: true, conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null,
    },
    runFullSuite: { stepId: "full-suite:1", passed: true, layers: [], output: "" },
    checkTaskFileFence: { inside: true, violations: [] },
    mergeTaskWorktree: { merged: true, commits: [], failureReason: null },
    recordMergeCommits: { commits: [] },
    writeTaskExitNotes: { exitType: "completed", exitNote: "" },
    recordTaskModifiedFiles: { modifiedFiles: [] },
    markTaskInactive: { active: false, endedAt: "2026-08-13T00:00:00.000Z" },
    releaseTaskRunHolds: { leaseReleased: true, leaseRetained: false, lockReleased: true },
    cleanupTaskWorktree: { removed: true, retainedArtifacts: [] },
    buildClosureNote: { closureNote: "done" },
    closeTaskRun: { closed: [TASK], skipped: [], ambiguous: [], unblocked: [] },
    reconcileStep: { status: "not-completed", result: null, note: "nothing landed" },
};

type RunRecord = {
    result: { task: number; exitType: string; exitNote: string; chainRan: boolean };
    calls: string[];
    payloads: { box: string; payload: Record<string, unknown> }[];
    countOf: (box: string) => number;
};

// `overrides` maps a box name to a function of its visit number (1-based), so a test can make
// the same box answer differently on its first and second visit.
const runWorkflow = async (
    overrides: Record<string, (visit: number, payload: Record<string, unknown>) => unknown> = {},
    argsOverride: Record<string, unknown> = {},
): Promise<RunRecord> => {
    const calls: string[] = [];
    const payloads: { box: string; payload: Record<string, unknown> }[] = [];
    const visits: Record<string, number> = {};

    const stubAgent: StubAgent = async (prompt, options) => {
        const box = boxOf(options.label);
        const payload = payloadOf(prompt);
        calls.push(box);
        payloads.push({ box, payload });
        visits[box] = (visits[box] ?? 0) + 1;
        if (overrides[box]) return overrides[box](visits[box], payload);
        assert.ok(box in happyResponses, `no stub response for box ${box}`);
        return happyResponses[box];
    };

    const compiled = compileFunction(
        `return (async () => { 'use strict'\n${workflowSource}\n })()`,
        ["args", "log", "agent"],
        { filename: workflowPath },
    ) as (a: string, l: (m: string) => void, g: StubAgent) => Promise<RunRecord["result"]>;

    const result = await compiled(
        JSON.stringify({ ...workflowArgs, ...argsOverride }), () => {}, stubAgent,
    );
    return { result, calls, payloads, countOf: (box) => calls.filter((name) => name === box).length };
};

test("test_workflow_reachesCompletedOnTheHappyPath", async () => {
    // Setup: every box answers happily, so this proves the stub map and the diagram wiring agree.
    const run = await runWorkflow();

    // Verification: the success chain ran to the archive box.
    assert.equal(run.result.exitType, "completed");
    assert.equal(run.countOf("closeTaskRun"), 1);
});

// --------------------------------------------------------------------------
// Finding 5 — the plan-scrap counter
// --------------------------------------------------------------------------

test("test_workflow_exitsPlanScrappedOnTheSecondInvalidPlanWithoutAThirdPlannerVisit", async () => {
    // Setup: the plan file never validates, so every planning round is a scrap.
    const run = await runWorkflow({
        validatePlanFile: () => ({ valid: false, problem: "no sections", sectionIds: [] }),
    });

    // Verification: two planner visits, then the exit — never a third.
    assert.equal(run.countOf("plan"), 2);
    assert.equal(run.result.exitType, "plan-scrapped");
    assert.equal(run.result.exitNote, "codex scrapped the plan twice");
});

test("test_workflow_exitsPlanScrappedOnTheSecondScrapVerdict", async () => {
    // Setup: codex scraps the plan every round.
    const run = await runWorkflow({
        validateCodexReview: () => ({ valid: true, problem: null, verdict: "scrap", scrapNotes: "start again" }),
    });

    // Verification: the second scrap ends it, and the first one fed its notes back as a preamble.
    assert.equal(run.countOf("plan"), 2);
    assert.equal(run.result.exitType, "plan-scrapped");
    const plannerPayloads = run.payloads.filter((entry) => entry.box === "plan");
    assert.equal(plannerPayloads[0].payload.preamble, "");
    assert.equal(plannerPayloads[1].payload.preamble, "start again");
});

// --------------------------------------------------------------------------
// Finding 2 — reconciling the proved-safe rerun
// --------------------------------------------------------------------------

test("test_workflow_reconcilesTheProvedSafeRerunWhenItsResultIsAlsoLost", async () => {
    // Setup: the claim loses its result, reconciliation proves nothing landed, the rerun
    // lands the claim but loses its result too.
    const run = await runWorkflow({
        claimTaskRun: () => null,
        reconcileStep: (visit) => (visit === 1
            ? { status: "not-completed", result: null, note: "no claim on record" }
            : { status: "completed", result: { status: "claimed", heldByRunId: null }, note: null }),
    });

    // Verification: two reconciliations, exactly two claim attempts, and the run carried on.
    assert.equal(run.countOf("claimTaskRun"), 2);
    assert.equal(run.countOf("reconcileStep"), 2);
    assert.equal(run.result.exitType, "completed");
});

test("test_workflow_neverRunsAMutatingBoxAThirdTime", async () => {
    // Setup: both results are lost and reconciliation proves nothing landed either time.
    const run = await runWorkflow({
        claimTaskRun: () => null,
        reconcileStep: () => ({ status: "not-completed", result: null, note: "no claim on record" }),
    });

    // Verification: two attempts, two reconciliations, then run-failed — no third mutation.
    assert.equal(run.countOf("claimTaskRun"), 2);
    assert.equal(run.countOf("reconcileStep"), 2);
    assert.equal(run.result.exitType, "run-failed");
    // The claim never landed, so there is no run record to write to.
    assert.equal(run.result.chainRan, false);
});

test("test_workflow_usesTheAmbiguousNoteOfTheSecondReconciliation", async () => {
    // Setup: the second reconciliation cannot decide what happened.
    const run = await runWorkflow({
        commitTaskWork: () => null,
        reconcileStep: (visit) => (visit === 1
            ? { status: "not-completed", result: null, note: "no commit at HEAD" }
            : { status: "ambiguous", result: null, note: "HEAD moved but no hash on record" }),
    });

    // Verification: the exit note repeats what could not be determined, word for word.
    assert.equal(run.result.exitType, "run-failed");
    assert.match(run.result.exitNote, /HEAD moved but no hash on record/);
    // The claim landed, so the whole exit chain runs.
    assert.equal(run.result.chainRan, true);
    assert.equal(run.countOf("releaseTaskRunHolds"), 1);
});

// --------------------------------------------------------------------------
// Finding 3 — a yellow box is dispatched exactly once
// --------------------------------------------------------------------------

test("test_workflow_dispatchesTheImplementRoleExactlyOnceWhenItsResultIsLost", async () => {
    // Setup: implement edits the worktree, then its result is lost.
    const run = await runWorkflow({ implement: () => null });

    // Verification: no re-spawn, and the claimed run is finalized through the exit chain.
    assert.equal(run.countOf("implement"), 1);
    assert.equal(run.result.exitType, "run-failed");
    assert.equal(run.result.chainRan, true);
    assert.equal(run.countOf("releaseTaskRunHolds"), 1);
});

test("test_workflow_dispatchesARepairRoleExactlyOnceWhenItsResultIsLost", async () => {
    // Setup: the task tests are red, so the fix-tests repair role runs, and loses its result.
    const run = await runWorkflow({
        runTaskTests: () => ({
            stepId: "task-tests:1", passed: false, testFiles: [], createdTestFiles: [],
            deletedTestFiles: [], missingTests: false, output: "1 failing",
        }),
        "fix-tests": () => null,
    });

    // Verification: the repair role ran once, never twice.
    assert.equal(run.countOf("fix-tests"), 1);
    assert.equal(run.result.exitType, "run-failed");
    assert.equal(run.result.chainRan, true);
});

test("test_workflow_neverReconcilesAYellowBox", async () => {
    // Setup: a lost role result must not enter the green-box reconciliation path.
    const run = await runWorkflow({ "amend-tests": () => null, "review-tests": () => ({ flagged: true, reviewer: "codex" }) });

    // Verification: no reconciliation was attempted for the role.
    assert.equal(run.countOf("amend-tests"), 1);
    assert.equal(run.countOf("reconcileStep"), 0);
});

// --------------------------------------------------------------------------
// Finding 4 — an operational failure carries its stderr into the exit note
// --------------------------------------------------------------------------

test("test_workflow_recordsTheStderrOfAMutatingBoxThatFailsOperationally", async () => {
    // Setup: the commit box exits non-zero after the claim landed.
    const run = await runWorkflow({
        commitTaskWork: () => { throw new Error("SENTINEL_COMMIT_STDERR"); },
    });

    // Verification: the sentinel reaches both the workflow result and the stored exit note.
    assert.equal(run.result.exitType, "run-failed");
    assert.match(run.result.exitNote, /SENTINEL_COMMIT_STDERR/);
    const exitNotes = run.payloads.find((entry) => entry.box === "writeTaskExitNotes");
    assert.ok(exitNotes);
    assert.match(String(exitNotes.payload.exitNote), /SENTINEL_COMMIT_STDERR/);
    // The chain still releases what the run holds.
    assert.equal(run.countOf("releaseTaskRunHolds"), 1);
});

test("test_workflow_neverReconcilesAnOperationalFailure", async () => {
    // Setup: a non-zero exit is not a lost result, so reconciliation must not run.
    const run = await runWorkflow({
        commitTaskWork: () => { throw new Error("SENTINEL_COMMIT_STDERR"); },
    });

    // Verification: the box ran once and no reconciliation was attempted.
    assert.equal(run.countOf("commitTaskWork"), 1);
    assert.equal(run.countOf("reconcileStep"), 0);
});

test("test_workflow_reportsAPreClaimOperationalFailureWithoutTouchingTasksJson", async () => {
    // Setup: a read-only box exits non-zero before there is any run to write to.
    const run = await runWorkflow({
        isTaskNumberValid: () => { throw new Error("SENTINEL_PREFLIGHT_STDERR"); },
    });

    // Verification: the stderr survives, and no exit-chain box ran.
    assert.equal(run.result.exitType, "run-failed");
    assert.match(run.result.exitNote, /SENTINEL_PREFLIGHT_STDERR/);
    assert.equal(run.result.chainRan, false);
    assert.equal(run.countOf("writeTaskExitNotes"), 0);
    assert.equal(run.countOf("markTaskInactive"), 0);
});

test("test_workflow_doesNotRetryAReadOnlyBoxThatFailsOperationally", async () => {
    // Setup: a non-zero exit is a verdict about the world, not a lost message.
    const run = await runWorkflow({
        isTaskNumberValid: () => { throw new Error("SENTINEL_PREFLIGHT_STDERR"); },
    });

    // Verification: one attempt only, even though a lost result would have earned three.
    assert.equal(run.countOf("isTaskNumberValid"), 1);
});

test("test_workflow_retriesAReadOnlyBoxThatLosesItsResult", async () => {
    // Setup: re-reading the world changes nothing, so a lost read-only result is re-spawned.
    const run = await runWorkflow({
        isTaskNumberValid: (visit) => (visit < 3 ? null : { valid: true, location: "open" }),
    });

    // Verification: three attempts, and the run carried on.
    assert.equal(run.countOf("isTaskNumberValid"), 3);
    assert.equal(run.result.exitType, "completed");
});

// --------------------------------------------------------------------------
// Finding 7 — preflight keeps the two diagnostics apart
// --------------------------------------------------------------------------

test("test_workflow_namesThePartialCloseWhenTheTaskIsInBothFiles", async () => {
    // Setup: a close that stopped halfway leaves the task in tasks.json and completedTasks.json.
    const run = await runWorkflow({
        isTaskOpen: () => ({ open: false, closeInProgress: true }),
    });

    // Verification: the note names the partial close, and nothing was written to tasks.json.
    assert.equal(run.result.exitType, "not-open");
    assert.match(run.result.exitNote, /a previous close did not finish/);
    assert.equal(run.result.chainRan, false);
    assert.equal(run.countOf("writeTaskExitNotes"), 0);
});

test("test_workflow_saysAlreadyCompletedWhenTheTaskIsOnlyArchived", async () => {
    // Setup: an ordinary completed task, absent from tasks.json.
    const run = await runWorkflow({
        isTaskOpen: () => ({ open: false, closeInProgress: false }),
    });

    // Verification: the plain note, distinct from the partial-close one.
    assert.equal(run.result.exitType, "not-open");
    assert.equal(run.result.exitNote, "task is already completed");
});

test("test_workflow_namesTheArchivalCloseWhenTheClaimReportsClosing", async () => {
    // Setup: the task is closing, so the claim is refused for a different reason.
    const run = await runWorkflow({
        claimTaskRun: () => ({ status: "closing", heldByRunId: null }),
    });

    // Verification: the note says archival, not a held claim, and no exit-chain box ran.
    assert.equal(run.result.exitType, "already-active");
    assert.match(run.result.exitNote, /being archived/);
    assert.equal(run.result.chainRan, false);
    assert.equal(run.countOf("writeTaskExitNotes"), 0);
});

test("test_workflow_namesTheHeldClaimWhenTheClaimIsRefused", async () => {
    // Setup: a previous run left the claim held.
    const run = await runWorkflow({
        claimTaskRun: () => ({ status: "refused", heldByRunId: "run-old" }),
    });

    // Verification: the held-claim note, distinct from the closing one.
    assert.equal(run.result.exitType, "already-active");
    assert.equal(run.result.exitNote, "a previous run left the claim held");
});

// --------------------------------------------------------------------------
// Finding 1 — ownership is established on every existing-worktree path
// --------------------------------------------------------------------------

test("test_workflow_establishesTheLeaseBeforeWritingToASafeExistingWorktree", async () => {
    // Setup: a retained worktree from an ended run, structurally safe.
    const run = await runWorkflow({
        doesTaskWorktreeExist: () => ({ exists: true, worktree: "/abs/repo/.worktrees/task-169" }),
        checkTaskWorktreeSafe: () => ({ safe: true, problems: [] }),
    });

    // Verification: the lease box ran, and it ran before the first box that writes to the worktree.
    assert.equal(run.countOf("isTaskRunResumable"), 1);
    assert.ok(run.calls.indexOf("isTaskRunResumable") < run.calls.indexOf("updateTaskDocs"));
    assert.equal(run.result.exitType, "completed");
});

test("test_workflow_refusesAnExistingWorktreeWhoseLeaseAnotherLiveRunOwns", async () => {
    // Setup: the lease could be neither adopted nor acquired.
    const run = await runWorkflow({
        doesTaskWorktreeExist: () => ({ exists: true, worktree: "/abs/repo/.worktrees/task-169" }),
        isTaskRunResumable: () => ({ resumable: false, implementationNotesFile: null, leaseEstablished: false }),
    });

    // Verification: the run stops before any box writes to that worktree.
    assert.equal(run.result.exitType, "run-failed");
    assert.match(run.result.exitNote, /lease is held by a live run/);
    assert.equal(run.countOf("updateTaskDocs"), 0);
    assert.equal(run.countOf("generateTaskDocs"), 0);
});

test("test_workflow_establishesTheLeaseBeforeResettingAnUnsafeWorktree", async () => {
    // Setup: an unsafe, unresumable worktree still needs its lease established before the reset.
    const run = await runWorkflow({
        doesTaskWorktreeExist: () => ({ exists: true, worktree: "/abs/repo/.worktrees/task-169" }),
        checkTaskWorktreeSafe: () => ({ safe: false, problems: ["detached head"] }),
        isTaskRunResumable: () => ({ resumable: false, implementationNotesFile: null, leaseEstablished: true }),
    });

    // Verification: the reset happened, and ownership came first.
    assert.equal(run.countOf("resetTaskWorktree"), 1);
    assert.ok(run.calls.indexOf("isTaskRunResumable") < run.calls.indexOf("resetTaskWorktree"));
});
