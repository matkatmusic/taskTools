// Checks tracePipeline.ts's box-by-box walk for one set of decisions. Run alone: node --test tests/tracePipeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { traceTaskPipeline, readNamedPaths, type PipelineDecisions } from "../scripts/tracePipeline.ts";

const AGENT = "<-- AGENT -->";

const runStart = (taskNumber: number): string => `Run start: Task Num [${taskNumber}]`;

// One pass through plan -> review plan -> implement -> task tests -> review tests, all accepted first try.
const PLAN_THROUGH_REVIEW_TESTS_CLEAN = [
    "--------- plan ---------",
    "Input: { brief, docs, codexNotes? }",
    `${AGENT} plan the task`,
    "what did the planner return?: PLAN",
    "--------- review plan ---------",
    "Input: { tasks.json entry, plan }",
    `${AGENT} codex reviews the plan`,
    "what is the review verdict?: ACCEPT",
    "--------- implement ---------",
    "Input: { plan, tasks.json entry }",
    `${AGENT} implement task`,
    "commit if needed",
    "--------- task tests ---------",
    "Input: { worktree, task test files }",
    `${AGENT} run task tests`,
    "do the task tests pass?: YES",
    "--------- review task tests ---------",
    "Input: { plan, tasks.json entry, task test files, implementation diff, test command, test results, pre-existing test files }",
    `${AGENT} codex reviews the tests`,
    "are the tests flagged?: NO",
];

// The lock, rebase, suite and fence tail taking every "clean" edge.
const REBASE_THROUGH_FENCE_CLEAN = [
    "--------- rebase preamble ---------",
    "Input: { runId, taskNumber }",
    "Try: lock the source repo",
    "acquired?: YES",
    "--------- rebase ---------",
    "Input: { worktree, target branch, merge receipt }",
    `${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`,
    "did the rebase report conflicts?: NO",
    "--------- full suite ---------",
    "Input: { worktree }",
    `${AGENT} run the full suite`,
    "do all tests pass?: YES",
    "did every change stay inside the task's file fence?: YES",
];

// The rebase and suite tail alone, re-run by a merge retry; the lock is taken only once.
const REBASE_THROUGH_FENCE_RETRY = [
    "--------- rebase ---------",
    "Input: { worktree, target branch, merge receipt }",
    `${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`,
    "did the rebase report conflicts?: NO",
    "--------- full suite ---------",
    "Input: { worktree }",
    `${AGENT} run the full suite`,
    "do all tests pass?: YES",
    "did every change stay inside the task's file fence?: YES",
];

const MERGE_LANDS = [
    "--------- merge ---------",
    "Input: { worktree, target branch, merge receipt so far }",
    "Try: merge worktrees and submodules, no fast-forward. Each layer that lands writes its merge ref AS it lands",
    "read the publication state from the layer merge refs",
    "what is the publication state?: ALL LANDED",
];

const CLOSE_OUT = [
    "--------- merge succeeded exit ---------",
    "Input: { merge commit hashes, modified files }",
    "record merge commit hashes to tasks.json",
    "write exit type completed to tasks.json",
    "record modified files to tasks.json",
    "clean up worktrees, leases, persistence refs and source lock",
    "build the closure note from the recorded run",
    "mark task inactive in tasks.json",
    "move task to completedTasks.json and update tasks blocked by it",
    "report the closure note",
    "stop",
];

// The happy-path tail from the rebase preamble banner to the finished run.
const REBASE_MERGE_AND_CLOSE_CLEAN = [...REBASE_THROUGH_FENCE_CLEAN, ...MERGE_LANDS, ...CLOSE_OUT];

// The common exit chain. The lease is always held; only the source lock varies.
const exitChain = (exitType: string, holdsLock: boolean, workLanded = false): string[] => [
    "read the publication state from the layer merge refs",
    `did ANY of this task's work land?: ${workLanded ? "YES" : "NO"}`,
    workLanded
        ? "write the publication outcome: keep completed if it is there, else write partially-published. NEVER run-failed. add cleanup-incomplete and the note"
        : `write exit type and exit notes to tasks.json: ${exitType}`,
    "record modified files to tasks.json",
    "does this run still hold the worktree lease?: YES",
    "release the worktree lease, keep the worktree",
    `does this run still hold the source repo lock?: ${holdsLock ? "YES" : "NO"}`,
    ...(holdsLock ? ["release the source repo lock"] : []),
    "mark task inactive in tasks.json",
    `report the run's exit type and note: ${exitType}`,
    "stop",
];

// A base set of decisions for the all-clean happy path; tests override only what they exercise.
const CLEAN: PipelineDecisions = {
    taskNumber: 42,
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

// A loop repeat indents further, forever. Banners bypass indentation, so they stay flush left.
const indent = (lines: string[], level = 1): string[] =>
    lines.map((line) => (line.startsWith("---------") ? line : "  ".repeat(level) + line));

// ---------------------------------------------------------------- the happy path

test("test_traceTaskPipeline_walksTheHappyPathToCompletion", () => {
    const trace = traceTaskPipeline(CLEAN);
    assert.deepEqual(trace, [runStart(42), ...PLAN_THROUGH_REVIEW_TESTS_CLEAN, ...REBASE_MERGE_AND_CLOSE_CLEAN]);
});

// ------------------------------------------------------------------------------- the plan loop

test("test_traceTaskPipeline_appliesCodexAmendmentsOnceThenAccepts", () => {
    const trace = traceTaskPipeline({ ...CLEAN, planVerdict: ["AMEND", "ACCEPT"] });
    assert.deepEqual(trace, [
        runStart(42),
        "--------- plan ---------",
        "Input: { brief, docs, codexNotes? }",
        `${AGENT} plan the task`,
        "what did the planner return?: PLAN",
        "--------- review plan ---------",
        "Input: { tasks.json entry, plan }",
        `${AGENT} codex reviews the plan`,
        "what is the review verdict?: AMEND",
        "update tasks.json entry",
        "2 codex reviews done?: NO",
        ...indent(PLAN_THROUGH_REVIEW_TESTS_CLEAN),
        ...indent(REBASE_THROUGH_FENCE_CLEAN),
        ...indent(MERGE_LANDS),
        ...indent(CLOSE_OUT),
    ]);
});

test("test_traceTaskPipeline_exitsPlanScrappedWhenCodexScrapsTwice", () => {
    const trace = traceTaskPipeline({ ...CLEAN, planVerdict: ["SCRAP", "SCRAP"] });
    assert.deepEqual(trace, [
        runStart(42),
        "--------- plan ---------",
        "Input: { brief, docs, codexNotes? }",
        `${AGENT} plan the task`,
        "what did the planner return?: PLAN",
        "--------- review plan ---------",
        "Input: { tasks.json entry, plan }",
        `${AGENT} codex reviews the plan`,
        "what is the review verdict?: SCRAP",
        "update tasks.json entry",
        "2 codex reviews done?: NO",
        "--------- plan ---------",
        ...indent(["Input: { brief, docs, codexNotes? }", `${AGENT} plan the task`, "what did the planner return?: PLAN"]),
        "--------- review plan ---------",
        ...indent([
            "Input: { tasks.json entry, plan }",
            `${AGENT} codex reviews the plan`,
            "what is the review verdict?: SCRAP",
            "update tasks.json entry",
            "2 codex reviews done?: YES",
        ]),
        "--------- failures exit ---------",
        ...indent(exitChain("PLAN-SCRAPPED", false)),
    ]);
});

test("test_traceTaskPipeline_exitsClarifyStuckAfterTwoClarifyRounds", () => {
    const trace = traceTaskPipeline({ ...CLEAN, plannerOutcome: ["CLARIFY", "CLARIFY", "CLARIFY"] });
    assert.deepEqual(trace, [
        runStart(42),
        "--------- plan ---------",
        "Input: { brief, docs, codexNotes? }",
        `${AGENT} plan the task`,
        "what did the planner return?: CLARIFY",
        "2 clarify rounds done?: NO",
        "write the clarify request into the tasks.json entry",
        "--------- document generation ---------",
        ...indent(["Input: { worktree, docs mode, clarify request? }", "what is the docs mode?: UPDATE", "update auto generated docs"]),
        "--------- plan ---------",
        ...indent([
            "Input: { brief, docs, codexNotes? }",
            `${AGENT} plan the task`,
            "what did the planner return?: CLARIFY",
            "2 clarify rounds done?: NO",
            "write the clarify request into the tasks.json entry",
        ]),
        "--------- document generation ---------",
        ...indent(["Input: { worktree, docs mode, clarify request? }", "what is the docs mode?: UPDATE", "update auto generated docs"], 2),
        "--------- plan ---------",
        ...indent(["Input: { brief, docs, codexNotes? }", `${AGENT} plan the task`, "what did the planner return?: CLARIFY", "2 clarify rounds done?: YES"], 2),
        "--------- failures exit ---------",
        ...indent(exitChain("CLARIFY-STUCK", false), 2),
    ]);
});

test("test_traceTaskPipeline_exitsAgentFailedWhenThePlannerReturnsError", () => {
    const trace = traceTaskPipeline({ ...CLEAN, plannerOutcome: ["ERROR"] });
    assert.deepEqual(trace, [
        runStart(42),
        "--------- plan ---------",
        "Input: { brief, docs, codexNotes? }",
        `${AGENT} plan the task`,
        "what did the planner return?: ERROR",
        "--------- failures exit ---------",
        ...exitChain("AGENT-FAILED", false),
    ]);
});

// ------------------------------------------------------------------------- the task-test loop

test("test_traceTaskPipeline_exitsTestsRedWhenTaskTestsFailTwice", () => {
    const trace = traceTaskPipeline({ ...CLEAN, taskTestsPass: [false, false] });
    assert.deepEqual(trace, [
        runStart(42),
        "--------- plan ---------",
        "Input: { brief, docs, codexNotes? }",
        `${AGENT} plan the task`,
        "what did the planner return?: PLAN",
        "--------- review plan ---------",
        "Input: { tasks.json entry, plan }",
        `${AGENT} codex reviews the plan`,
        "what is the review verdict?: ACCEPT",
        "--------- implement ---------",
        "Input: { plan, tasks.json entry }",
        `${AGENT} implement task`,
        "commit if needed",
        "--------- task tests ---------",
        "Input: { worktree, task test files }",
        `${AGENT} run task tests`,
        "do the task tests pass?: NO",
        "have 2 fixes already been attempted?: NO",
        "amend tasks.json entry with the failing tests",
        "--------- implement ---------",
        ...indent(["Input: { plan, tasks.json entry }", `${AGENT} implement task`, "commit if needed"]),
        "--------- task tests ---------",
        ...indent([
            "Input: { worktree, task test files }",
            `${AGENT} run task tests`,
            "do the task tests pass?: NO",
            "have 2 fixes already been attempted?: NO",
            "amend tasks.json entry with the failing tests",
        ]),
        "--------- implement ---------",
        ...indent(["Input: { plan, tasks.json entry }", `${AGENT} implement task`, "commit if needed"], 2),
        "--------- task tests ---------",
        ...indent(["Input: { worktree, task test files }", `${AGENT} run task tests`, "do the task tests pass?: NO", "have 2 fixes already been attempted?: YES"], 2),
        "--------- failures exit ---------",
        ...indent(exitChain("TESTS-RED", false), 2),
    ]);
});

// -------------------------------------------------------------------- the codex test review loop

test("test_traceTaskPipeline_exitsTestsFlaggedWhenCodexFlagsTheTestsTwice", () => {
    // testReviews is read before it increments, so two flagged entries still run three rounds.
    const trace = traceTaskPipeline({ ...CLEAN, testsFlagged: [true, true] });
    const oneFlaggedRound = (reviewsDone: boolean) => [
        "Input: { plan, tasks.json entry, task test files, implementation diff, test command, test results, pre-existing test files }",
        `${AGENT} codex reviews the tests`,
        "are the tests flagged?: YES",
        `2 codex test reviews done?: ${reviewsDone ? "YES" : "NO"}`,
    ];
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN.slice(0, -3),
        ...oneFlaggedRound(false),
        "amend tasks.json entry with codex's notes and fixes",
        "--------- implement ---------",
        ...indent(["Input: { plan, tasks.json entry }", `${AGENT} implement task`, "commit if needed"]),
        "--------- task tests ---------",
        ...indent(["Input: { worktree, task test files }", `${AGENT} run task tests`, "do the task tests pass?: YES"]),
        "--------- review task tests ---------",
        ...indent(oneFlaggedRound(false)),
        ...indent(["amend tasks.json entry with codex's notes and fixes"]),
        "--------- implement ---------",
        ...indent(["Input: { plan, tasks.json entry }", `${AGENT} implement task`, "commit if needed"], 2),
        "--------- task tests ---------",
        ...indent(["Input: { worktree, task test files }", `${AGENT} run task tests`, "do the task tests pass?: YES"], 2),
        "--------- review task tests ---------",
        ...indent(oneFlaggedRound(true), 2),
        "--------- failures exit ---------",
        ...indent(exitChain("TESTS-FLAGGED", false), 2),
    ]);
});

// ------------------------------------------------------------------------ the source repo lock

test("test_traceTaskPipeline_exitsRunFailedWhenTheSourceRepoLockIsNotAcquired", () => {
    const trace = traceTaskPipeline({ ...CLEAN, lockAcquired: [false] });
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        "--------- rebase preamble ---------",
        "Input: { runId, taskNumber }",
        "Try: lock the source repo",
        "acquired?: NO",
        "have 15 minutes passed?: YES",
        "--------- failures exit ---------",
        ...exitChain("RUN-FAILED", false),
    ]);
});

// ------------------------------------------------------------------------------ the rebase loop

test("test_traceTaskPipeline_fixesConflictsWhenTheRebaseReportsThemOnce", () => {
    const trace = traceTaskPipeline({ ...CLEAN, rebaseConflicts: [true, false], rebaseFinished: [true] });
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        "--------- rebase preamble ---------",
        "Input: { runId, taskNumber }",
        "Try: lock the source repo",
        "acquired?: YES",
        "--------- rebase ---------",
        "Input: { worktree, target branch, merge receipt }",
        `${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`,
        "did the rebase report conflicts?: YES",
        "2 conflict fixes done?: NO",
        `${AGENT} fix conflicts`,
        "commit if needed",
        `${AGENT} continue the rebase`,
        "is the rebase finished?: YES",
        "--------- full suite ---------",
        "Input: { worktree }",
        `${AGENT} run the full suite`,
        "do all tests pass?: YES",
        "did every change stay inside the task's file fence?: YES",
        ...MERGE_LANDS,
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_exitsRebaseStuckWhenTwoConflictFixesNeverAdvanceTheReplay", () => {
    const trace = traceTaskPipeline({ ...CLEAN, rebaseConflicts: [true, true], rebaseFinished: [false] });
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        "--------- rebase preamble ---------",
        "Input: { runId, taskNumber }",
        "Try: lock the source repo",
        "acquired?: YES",
        "--------- rebase ---------",
        "Input: { worktree, target branch, merge receipt }",
        `${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`,
        "did the rebase report conflicts?: YES",
        "2 conflict fixes done?: NO",
        `${AGENT} fix conflicts`,
        "commit if needed",
        `${AGENT} continue the rebase`,
        "is the rebase finished?: NO",
        ...indent([
            `${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`,
            "did the rebase report conflicts?: YES",
            "2 conflict fixes done?: NO",
            `${AGENT} fix conflicts`,
            "commit if needed",
            `${AGENT} continue the rebase`,
            "is the rebase finished?: NO",
        ]),
        ...indent(
            [`${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`, "did the rebase report conflicts?: YES", "2 conflict fixes done?: YES"],
            2,
        ),
        "--------- failures exit ---------",
        ...indent(exitChain("REBASE-STUCK", true), 2),
    ]);
});

// ------------------------------------------------------------------------------- the full-suite loop

test("test_traceTaskPipeline_exitsSuiteRedWhenTheFullSuiteFailsTwice", () => {
    const trace = traceTaskPipeline({ ...CLEAN, suitePasses: [false, false] });
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        "--------- rebase preamble ---------",
        "Input: { runId, taskNumber }",
        "Try: lock the source repo",
        "acquired?: YES",
        "--------- rebase ---------",
        "Input: { worktree, target branch, merge receipt }",
        `${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`,
        "did the rebase report conflicts?: NO",
        "--------- full suite ---------",
        "Input: { worktree }",
        `${AGENT} run the full suite`,
        "do all tests pass?: NO",
        "2 suite fix attempts done?: NO",
        `${AGENT} fix the codebase so the full suite passes`,
        "commit if needed",
        ...indent([`${AGENT} run the full suite`, "do all tests pass?: NO", "2 suite fix attempts done?: NO", `${AGENT} fix the codebase so the full suite passes`, "commit if needed"]),
        ...indent([`${AGENT} run the full suite`, "do all tests pass?: NO", "2 suite fix attempts done?: YES"], 2),
        "--------- failures exit ---------",
        ...indent(exitChain("SUITE-RED", true), 2),
    ]);
});

// ------------------------------------------------------------------------------- fence and merge

test("test_traceTaskPipeline_exitsFenceViolationWhenAStepChangedAFileTheTaskDoesNotOwn", () => {
    const trace = traceTaskPipeline({ ...CLEAN, fenceHeld: false });
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        "--------- rebase preamble ---------",
        "Input: { runId, taskNumber }",
        "Try: lock the source repo",
        "acquired?: YES",
        "--------- rebase ---------",
        "Input: { worktree, target branch, merge receipt }",
        `${AGENT} rebase onto the target branch. skip every layer the receipt records as already landed`,
        "did the rebase report conflicts?: NO",
        "--------- full suite ---------",
        "Input: { worktree }",
        `${AGENT} run the full suite`,
        "do all tests pass?: YES",
        "did every change stay inside the task's file fence?: NO",
        "--------- failures exit ---------",
        ...exitChain("FENCE-VIOLATION", true),
    ]);
});

test("test_traceTaskPipeline_rebasesAndRetriesWhenTheMergeDoesNotLandTheFirstTime", () => {
    const trace = traceTaskPipeline({ ...CLEAN, publicationState: ["NONE LANDED", "ALL LANDED"] });
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        ...REBASE_THROUGH_FENCE_CLEAN,
        "--------- merge ---------",
        "Input: { worktree, target branch, merge receipt so far }",
        "Try: merge worktrees and submodules, no fast-forward. Each layer that lands writes its merge ref AS it lands",
        "read the publication state from the layer merge refs",
        "what is the publication state?: NONE LANDED",
        "2 merge attempts done?: NO",
        ...indent([...REBASE_THROUGH_FENCE_RETRY, ...MERGE_LANDS]),
        ...indent(CLOSE_OUT),
    ]);
});

test("test_traceTaskPipeline_exitsMergeFailedWhenTheMergeDoesNotLandTwice", () => {
    const trace = traceTaskPipeline({ ...CLEAN, publicationState: ["NONE LANDED", "NONE LANDED"] });
    const mergeNoneLanded = (attemptsDone: boolean) => [
        "--------- merge ---------",
        "Input: { worktree, target branch, merge receipt so far }",
        "Try: merge worktrees and submodules, no fast-forward. Each layer that lands writes its merge ref AS it lands",
        "read the publication state from the layer merge refs",
        "what is the publication state?: NONE LANDED",
        `2 merge attempts done?: ${attemptsDone ? "YES" : "NO"}`,
    ];
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        ...REBASE_THROUGH_FENCE_CLEAN,
        ...mergeNoneLanded(false),
        ...indent([...REBASE_THROUGH_FENCE_RETRY, ...mergeNoneLanded(false)]),
        ...indent([...REBASE_THROUGH_FENCE_RETRY, ...mergeNoneLanded(true)], 2),
        "--------- failures exit ---------",
        ...indent(exitChain("MERGE-FAILED", true), 2),
    ]);
});

test("test_traceTaskPipeline_exitsPartiallyPublishedWhenSomeLayersLandAndSomeDoNot", () => {
    const trace = traceTaskPipeline({ ...CLEAN, publicationState: ["SOME LANDED"] });
    assert.deepEqual(trace, [
        runStart(42),
        ...PLAN_THROUGH_REVIEW_TESTS_CLEAN,
        ...REBASE_THROUGH_FENCE_CLEAN,
        "--------- merge ---------",
        "Input: { worktree, target branch, merge receipt so far }",
        "Try: merge worktrees and submodules, no fast-forward. Each layer that lands writes its merge ref AS it lands",
        "read the publication state from the layer merge refs",
        "what is the publication state?: SOME LANDED",
        "--------- failures exit ---------",
        ...exitChain("PARTIALLY-PUBLISHED", true, true),
    ]);
});

// -------------------------------------------------------------------------- agent() errored

test("test_traceTaskPipeline_exitsAgentFailedWhenAnAgentBoxErrors", () => {
    const trace = traceTaskPipeline({ ...CLEAN, agentErrors: { PLANNER: [true] } });
    assert.deepEqual(trace, [
        runStart(42),
        "--------- plan ---------",
        "Input: { brief, docs, codexNotes? }",
        `${AGENT} plan the task`,
        "agent() errored",
        "--------- failures exit ---------",
        ...exitChain("AGENT-FAILED", false),
    ]);
});

// ------------------------------------------------------------------------------ coverage guards

test("test_traceTaskPipeline_marksEveryAgentRunBoxAndNoScriptBox", () => {
    // The current diagrams paint ten boxes orange. Walk decisions that visit every one.
    const decisionsExercisingEveryAgentBox: PipelineDecisions[] = [
        CLEAN,
        { ...CLEAN, rebaseConflicts: [true, false], rebaseFinished: [true] },
        { ...CLEAN, suitePasses: [false, true] },
    ];

    const marked = new Set<string>();
    for (const decisions of decisionsExercisingEveryAgentBox) {
        for (const line of traceTaskPipeline(decisions)) {
            if (line.trimStart().startsWith(`${AGENT} `)) marked.add(line.trimStart().replace(`${AGENT} `, ""));
        }
    }

    assert.deepEqual(
        [...marked].sort(),
        [
            "codex reviews the plan",
            "codex reviews the tests",
            "continue the rebase",
            "fix conflicts",
            "fix the codebase so the full suite passes",
            "implement task",
            "plan the task",
            "rebase onto the target branch. skip every layer the receipt records as already landed",
            "run task tests",
            "run the full suite",
        ].sort(),
    );
});

test("test_traceTaskPipeline_reachesEveryExitTypeItCanProduce", () => {
    // pipeline-failuresExit.mmd lists eleven exit types, plus the merge succeeded exit's "completed".
    const fixtures: PipelineDecisions[] = [
        CLEAN,
        { ...CLEAN, agentErrors: { PLANNER: [true] } },
        { ...CLEAN, plannerOutcome: ["CLARIFY", "CLARIFY", "CLARIFY"] },
        { ...CLEAN, planVerdict: ["SCRAP", "SCRAP"] },
        { ...CLEAN, taskTestsPass: [false, false] },
        { ...CLEAN, testsFlagged: [true, true] },
        { ...CLEAN, lockAcquired: [false] },
        { ...CLEAN, rebaseConflicts: [true, true], rebaseFinished: [false] },
        { ...CLEAN, suitePasses: [false, false] },
        { ...CLEAN, fenceHeld: false },
        { ...CLEAN, publicationState: ["NONE LANDED", "NONE LANDED"] },
        { ...CLEAN, publicationState: ["SOME LANDED"] },
    ];

    const reached = new Set<string>();
    for (const decisions of fixtures) {
        const lines = traceTaskPipeline(decisions).map((line) => line.trimStart());
        const completed = lines.includes("write exit type completed to tasks.json");
        const exitLine = lines.find(
            (line) => line.startsWith("report the run's exit type and note: ") || line.startsWith("write exit type and exit notes to tasks.json: "),
        );
        assert.ok(completed || exitLine !== undefined, "a fixture walked off the end without reaching an exit");
        reached.add(completed ? "COMPLETED" : exitLine!.split(": ")[1]!);
    }

    assert.deepEqual(
        [...reached].sort(),
        [
            "AGENT-FAILED",
            "CLARIFY-STUCK",
            "COMPLETED",
            "FENCE-VIOLATION",
            "MERGE-FAILED",
            "PARTIALLY-PUBLISHED",
            "PLAN-SCRAPPED",
            "REBASE-STUCK",
            "RUN-FAILED",
            "SUITE-RED",
            "TESTS-FLAGGED",
            "TESTS-RED",
        ],
    );
});

test("test_traceTaskPipeline_everyNamedPathEndsAtStop", () => {
    // A structural guard: every named path must trace to a run reaching "stop".
    const namedPaths = readNamedPaths();
    for (const [name, decisions] of Object.entries(namedPaths)) {
        const trace = traceTaskPipeline(decisions);
        assert.equal(trace.at(-1)?.trimStart(), "stop", `path "${name}" did not end at stop`);
    }
});
