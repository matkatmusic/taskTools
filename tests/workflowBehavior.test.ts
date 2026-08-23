// Retry caps and exit types of the tackle-tasks workflow, stated directly and read off its trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";

type AgentBoxName =
    | "PLANNER"
    | "PLAN_REVIEWER"
    | "IMPLEMENTER"
    | "TEST_RUNNER"
    | "TEST_REVIEWER"
    | "REBASER"
    | "CONFLICT_FIXER"
    | "REBASE_ADVANCER"
    | "SUITE_RUNNER"
    | "SUITE_FIXER";

// Loop decisions hold one entry per attempt: taskTestsPass [false, true] fails once, then passes.
type PipelineDecisions = {
    taskNumber: number;
    plannerOutcome: ("PLAN" | "CLARIFY" | "ERROR")[];
    planVerdict: ("ACCEPT" | "AMEND_THEN_ACCEPT" | "AMEND" | "SCRAP" | "ERROR")[];
    taskTestsPass: boolean[];
    testsFlagged: boolean[];
    lockAcquired: boolean[];
    rebaseConflicts: boolean[];
    rebaseFinished: boolean[];
    suitePasses: boolean[];
    fenceHeld: boolean;
    publicationState: ("ALL LANDED" | "NONE LANDED" | "SOME LANDED")[];
    // One entry per visit to an agent box; true means the harness lost that agent's result.
    agentErrors?: Partial<Record<AgentBoxName, boolean[]>>;
};

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_PATH = join(REPO_ROOT, "skills/tackle-tasks/tackle-tasks.workflow.js");
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8").replace("export const meta", "const meta");

const TASK = 169;

// Every decision answers happily, so a test overrides only the field it is about.
const HAPPY: PipelineDecisions = {
    taskNumber: TASK,
    plannerOutcome: ["PLAN"],
    planVerdict: ["ACCEPT"],
    taskTestsPass: [true],
    testsFlagged: [false],
    lockAcquired: [true],
    rebaseConflicts: [false],
    rebaseFinished: [true],
    suitePasses: [true],
    fenceHeld: true,
    publicationState: ["ALL LANDED"],
};

const hookPath = fileURLToPath(new URL("../../scripts/runStepHook.ts", import.meta.url));

// The retry counters the hook reads live in tasks.json, so fake mode gets a real one on disk.
const rootWithNoAttempts = (taskNumber: number): string => {
    const root = mkdtempSync(join(tmpdir(), "workflowBehavior-"));
    const record = {
        runId: "run-abc", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
        exitType: null, exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null, attempts: {},
    };
    const run = { active: true, worktree: null, leaseRunId: null, history: [record] };
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify([{ taskNumber, title: "t", run }], null, 2)}\n`);
    writeFileSync(join(root, "completedTasks.json"), "[]\n");
    return root;
};

// FAKE mode supplies every [C] decision, so the run walks offline and only a decision calls agent().
const runFake = async (overrides: Partial<PipelineDecisions> = {}): Promise<string[]> => {
    const fake = { ...HAPPY, ...overrides };
    const compiled = compileFunction(
        `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent", "phase"],
        { filename: WORKFLOW_PATH, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as (
        args: unknown,
        log: (...values: unknown[]) => void,
        agent: unknown,
        phase: unknown,
    ) => Promise<string[]>;
    const projectRoot = rootWithNoAttempts(fake.taskNumber);
    return compiled(
        { fake, task: fake.taskNumber, projectRoot, runId: "run-abc", sourceBranch: "master", worktree: "/abs/repo/.worktrees/task-1" },
        () => {},
        async (prompt: string) => {
            const command = prompt.match(/^\/run-step .*--decide.*$/m);
            if (command === null) throw new Error("real agent() must never be called in fake mode");
            const answered = spawnSync("node", [hookPath], {
                input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: command[0] }),
                encoding: "utf8",
            });
            return JSON.parse(JSON.parse(answered.stdout).hookSpecificOutput.additionalContext);
        },
        () => {},
    );
};

// Indentation marks loop depth, so every count here compares trimmed lines.
const countOf = (trace: string[], line: string): number =>
    trace.filter((entry) => entry.trim() === line).length;

// One visit to an orange box, whatever depth the loop had reached.
const countAgent = (trace: string[], label: string): number =>
    countOf(trace, `<-- AGENT --> ${label}`);

const indexOfLine = (trace: string[], line: string): number =>
    trace.findIndex((entry) => entry.trim() === line);

const exitTypeOf = (trace: string[]): string => {
    const reported = trace.find((entry) => entry.trim().startsWith("report the run's exit type and note: "));
    return reported === undefined ? "completed" : reported.trim().split(": ")[1]!;
};

// --------------------------------------------------------------------------
// The happy path
// --------------------------------------------------------------------------

test("test_workflow_reachesTheMergeSucceededExitWhenEveryDecisionIsHappy", async () => {
    // Setup: nothing overridden, so every decision takes its pass edge.
    const trace = await runFake();

    // Verification: the success tail ran, and no failures tail did.
    assert.equal(exitTypeOf(trace), "completed");
    assert.equal(countOf(trace, "write exit type completed to tasks.json"), 1);
    assert.equal(countOf(trace, "move task to completedTasks.json and update tasks blocked by it"), 1);
    assert.equal(countOf(trace, "--------- failures exit ---------"), 0);
    assert.equal(trace[trace.length - 1], "stop");
});

test("test_workflow_visitsEachAgentBoxOnceOnTheHappyPath", async () => {
    // Setup: the happy path touches six of the ten orange boxes, each exactly once.
    const trace = await runFake();

    // Verification: no repair box runs when nothing needs repairing.
    assert.equal(countAgent(trace, "plan the task"), 1);
    assert.equal(countAgent(trace, "codex reviews the plan"), 1);
    assert.equal(countAgent(trace, "implement task"), 1);
    assert.equal(countAgent(trace, "run task tests"), 1);
    assert.equal(countAgent(trace, "codex reviews the tests"), 1);
    assert.equal(countAgent(trace, "rebase onto the target branch. skip every layer the receipt records as already landed"), 1);
    assert.equal(countAgent(trace, "run the full suite"), 1);
    assert.equal(countAgent(trace, "fix conflicts"), 0);
    assert.equal(countAgent(trace, "continue the rebase"), 0);
    assert.equal(countAgent(trace, "fix the codebase so the full suite passes"), 0);
});

// --------------------------------------------------------------------------
// Retry caps — MAX_ATTEMPTS is 2 fix attempts, which allows 3 runs
// --------------------------------------------------------------------------

test("test_workflow_stopsClarifyingAfterTwoRoundsAndPlansAThirdTime", async () => {
    // Setup: the planner asks for clarification every time.
    const trace = await runFake({ plannerOutcome: ["CLARIFY"] });

    // Verification: two clarify rounds spent, so the third planner visit is the last one.
    assert.equal(countAgent(trace, "plan the task"), 3);
    assert.equal(countOf(trace, "write the clarify request into the tasks.json entry"), 2);
    assert.equal(exitTypeOf(trace), "CLARIFY-STUCK");
});

test("test_workflow_countsAPlanReviewBeforeAskingTheCapSoTwoReviewsEndIt", async () => {
    // The plan-review counter increments BEFORE its check, unlike every other counter.
    const trace = await runFake({ planVerdict: ["AMEND"] });

    // Verification: two reviews and two plans, never a third of either.
    assert.equal(countAgent(trace, "codex reviews the plan"), 2);
    assert.equal(countAgent(trace, "plan the task"), 2);
    assert.equal(exitTypeOf(trace), "PLAN-SCRAPPED");
});

test("test_workflow_treatsAScrapVerdictExactlyAsItTreatsAnAmendVerdict", async () => {
    // Both verdicts route through the same replan edge, so both spend the same cap.
    const amended = await runFake({ planVerdict: ["AMEND"] });
    const scrapped = await runFake({ planVerdict: ["SCRAP"] });

    // Verification: same box counts and same exit, differing only in the recorded verdict.
    assert.equal(countAgent(scrapped, "codex reviews the plan"), countAgent(amended, "codex reviews the plan"));
    assert.equal(exitTypeOf(scrapped), "PLAN-SCRAPPED");
    assert.equal(countOf(scrapped, "what is the review verdict?: SCRAP"), 2);
});

test("test_workflow_stopsFixingTaskTestsAfterTwoAttemptsAndRunsThemAThirdTime", async () => {
    // Setup: the task tests never go green.
    const trace = await runFake({ taskTestsPass: [false] });

    // Verification: the counter is read before the amend, so the first failure does not spend it.
    assert.equal(countAgent(trace, "run task tests"), 3);
    assert.equal(countAgent(trace, "implement task"), 3);
    assert.equal(countOf(trace, "amend tasks.json entry with the failing tests"), 2);
    assert.equal(exitTypeOf(trace), "TESTS-RED");
});

test("test_workflow_stopsReviewingTaskTestsAfterTwoFlaggedRoundsAndReviewsAThirdTime", async () => {
    // Setup: codex flags the tests every round.
    const trace = await runFake({ testsFlagged: [true] });

    // Verification: three reviews, two amendments, then the flagged exit.
    assert.equal(countAgent(trace, "codex reviews the tests"), 3);
    assert.equal(countOf(trace, "amend tasks.json entry with codex's notes and fixes"), 2);
    assert.equal(exitTypeOf(trace), "TESTS-FLAGGED");
});

test("test_workflow_stopsFixingConflictsAfterTwoAttemptsAndRebasesAThirdTime", async () => {
    // Setup: every rebase conflicts and no continue ever finishes it.
    const trace = await runFake({ rebaseConflicts: [true], rebaseFinished: [false] });

    // Verification: two conflict fixes spent, and the third rebase run is the last one.
    assert.equal(countAgent(trace, "rebase onto the target branch. skip every layer the receipt records as already landed"), 3);
    assert.equal(countAgent(trace, "fix conflicts"), 2);
    assert.equal(countAgent(trace, "continue the rebase"), 2);
    assert.equal(exitTypeOf(trace), "REBASE-STUCK");
});

test("test_workflow_stopsFixingTheSuiteAfterTwoAttemptsAndRunsItAThirdTime", async () => {
    // Setup: the full suite stays red.
    const trace = await runFake({ suitePasses: [false] });

    // Verification: three suite runs, two repair runs, then the red exit.
    assert.equal(countAgent(trace, "run the full suite"), 3);
    assert.equal(countAgent(trace, "fix the codebase so the full suite passes"), 2);
    assert.equal(exitTypeOf(trace), "SUITE-RED");
});

test("test_workflow_stopsRetryingTheMergeAfterTwoAttemptsAndMergesAThirdTime", async () => {
    // Setup: nothing ever lands, so the merge keeps sending the run back to rebase.
    const trace = await runFake({ publicationState: ["NONE LANDED"] });

    // Verification: three merge passes, and each retry re-entered rebase, never the rebase preamble.
    assert.equal(countOf(trace, "--------- merge ---------"), 3);
    assert.equal(countOf(trace, "--------- rebase ---------"), 3);
    assert.equal(countOf(trace, "--------- rebase preamble ---------"), 1);
    assert.equal(exitTypeOf(trace), "MERGE-FAILED");
});

test("test_workflow_neverResetsTheSuiteFixCounterWhenAMergeRetryRerunsTheSuite", async () => {
    // Setup: one suite repair, then a failed merge that sends the run back through the suite.
    const trace = await runFake({ suitePasses: [false, true, false, true], publicationState: ["NONE LANDED", "ALL LANDED"] });

    // Verification: the second pass through the suite spends the counter it inherited, not a fresh one.
    assert.equal(countAgent(trace, "fix the codebase so the full suite passes"), 2);
    assert.equal(countOf(trace, "2 suite fix attempts done?: YES"), 0);
    assert.equal(exitTypeOf(trace), "completed");
});

// --------------------------------------------------------------------------
// The five review verdicts of plans/diagram/pipeline-reviewPlan.mmd
// --------------------------------------------------------------------------

test("test_workflow_sendsAmendThenAcceptStraightToImplementWithoutUpdatingTheEntry", async () => {
    // The script already wrote codex's fixes into the plan, so there is nothing to replan.
    const trace = await runFake({ planVerdict: ["AMEND_THEN_ACCEPT"] });

    // Verification: one review, one plan, and no replan edge taken.
    assert.equal(countAgent(trace, "codex reviews the plan"), 1);
    assert.equal(countAgent(trace, "plan the task"), 1);
    assert.equal(countOf(trace, "update tasks.json entry"), 0);
    assert.equal(exitTypeOf(trace), "completed");
});

test("test_workflow_treatsAnErrorVerdictAsAnOperationalFailureNotAPlanDefect", async () => {
    // The reviewer never read the plan, so no ruling was possible and no cap is spent.
    const trace = await runFake({ planVerdict: ["ERROR"] });

    // Verification: run-failed, and the replan edge was never taken.
    assert.equal(exitTypeOf(trace), "RUN-FAILED");
    assert.equal(countOf(trace, "update tasks.json entry"), 0);
    assert.equal(countAgent(trace, "plan the task"), 1);
});

// --------------------------------------------------------------------------
// The dotted "agent() errored" edge, on all ten orange boxes
// --------------------------------------------------------------------------

// Each entry names the decisions that reach the box, and the box's label in the trace.
const AGENT_BOX_REACH: { box: string; label: string; reach: Partial<PipelineDecisions> }[] = [
    { box: "PLANNER", label: "plan the task", reach: {} },
    { box: "PLAN_REVIEWER", label: "codex reviews the plan", reach: {} },
    { box: "IMPLEMENTER", label: "implement task", reach: {} },
    { box: "TEST_RUNNER", label: "run task tests", reach: {} },
    { box: "TEST_REVIEWER", label: "codex reviews the tests", reach: {} },
    { box: "REBASER", label: "rebase onto the target branch. skip every layer the receipt records as already landed", reach: {} },
    { box: "CONFLICT_FIXER", label: "fix conflicts", reach: { rebaseConflicts: [true] } },
    { box: "REBASE_ADVANCER", label: "continue the rebase", reach: { rebaseConflicts: [true] } },
    { box: "SUITE_RUNNER", label: "run the full suite", reach: {} },
    { box: "SUITE_FIXER", label: "fix the codebase so the full suite passes", reach: { suitePasses: [false] } },
];

for (const { box, label, reach } of AGENT_BOX_REACH) {
    test(`test_workflow_exitsAgentFailedWhen${box}ReturnsNothing`, async () => {
        // Setup: the harness loses that one box's result on its first visit.
        const trace = await runFake({ ...reach, agentErrors: { [box]: [true] } as PipelineDecisions["agentErrors"] });

        // Verification: the dotted edge is drawn once, the box is never retried, and the run ends.
        assert.equal(countOf(trace, "agent() errored"), 1);
        assert.equal(countAgent(trace, label), 1);
        assert.equal(exitTypeOf(trace), "AGENT-FAILED");
    });
}

// --------------------------------------------------------------------------
// The failures tail reconciles the exit type against what actually landed
// --------------------------------------------------------------------------

test("test_workflow_discardsTheIncomingExitTypeWhenSomeLayersAlreadyLanded", async () => {
    // Setup: a partial publication, which is the one exit that carries landed work.
    const trace = await runFake({ publicationState: ["SOME LANDED"] });

    // Verification: the tail writes the publication outcome instead of the incoming exit type.
    assert.equal(countOf(trace, "did ANY of this task's work land?: YES"), 1);
    assert.equal(countOf(trace, "write the publication outcome: keep completed if it is there, else write partially-published. NEVER run-failed. add cleanup-incomplete and the note"), 1);
    assert.equal(countOf(trace, "write exit type and exit notes to tasks.json: PARTIALLY-PUBLISHED"), 0);
    assert.equal(exitTypeOf(trace), "PARTIALLY-PUBLISHED");
});

test("test_workflow_writesTheIncomingExitTypeWhenNothingLanded", async () => {
    // Setup: a fence violation, which merges nothing at all.
    const trace = await runFake({ fenceHeld: false });

    // Verification: nothing landed, so the incoming exit type is written verbatim.
    assert.equal(countOf(trace, "did ANY of this task's work land?: NO"), 1);
    assert.equal(countOf(trace, "write exit type and exit notes to tasks.json: FENCE-VIOLATION"), 1);
    assert.equal(exitTypeOf(trace), "FENCE-VIOLATION");
});

// --------------------------------------------------------------------------
// The source repo lock is released by whichever tail runs, and only if held
// --------------------------------------------------------------------------

test("test_workflow_releasesNoSourceLockWhenTheRunFailedBeforeTakingOne", async () => {
    // Setup: the lock never came free, so the run holds nothing to release.
    const trace = await runFake({ lockAcquired: [false] });

    // Verification: the tail answers NO and skips the release box.
    assert.equal(countOf(trace, "does this run still hold the source repo lock?: NO"), 1);
    assert.equal(countOf(trace, "release the source repo lock"), 0);
    assert.equal(exitTypeOf(trace), "RUN-FAILED");
});

test("test_workflow_releasesTheSourceLockOnAFailureTakenAfterItWasAcquired", async () => {
    // Setup: the suite stays red, which fails with the lock already held.
    const trace = await runFake({ suitePasses: [false] });

    // Verification: the tail answers YES and releases before marking the task inactive.
    assert.equal(countOf(trace, "does this run still hold the source repo lock?: YES"), 1);
    assert.equal(countOf(trace, "release the source repo lock"), 1);
    assert.ok(indexOfLine(trace, "release the source repo lock") < indexOfLine(trace, "mark task inactive in tasks.json"));
});
