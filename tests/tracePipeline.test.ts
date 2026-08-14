// Behavioral checks for tracePipeline.ts: the box-by-box walk of plans/diagram/pipeline.mmd
// for one set of decision outcomes. One test per path the pipeline can take.
// Run alone: node --test tests/tracePipeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { traceTaskPipeline, readNamedPaths, type PipelineDecisions } from "../scripts/tracePipeline.ts";

// A repeat of a loop is indented one level, so a second pass is visible without counting lines.
const indent = (lines: string[], level = 1): string[] => lines.map((line) => "  ".repeat(level) + line);

// Sub-pipeline boundary banners. Pushed directly by the tracer, so they are never indented,
// even when the surrounding lines sit inside a loop repeat.
const EXIT_BANNER = "--------- exit workflow ---------";

// Shared literal fragments. These are expected OUTPUT, not logic — each is a run of lines that
// several paths quote verbatim, kept in one place so a wording change is a one-line edit.
const ACTIVE_AND_UNBLOCKED = [
    "Run start: Task Num [42]",
    "--------- preamble ---------",
    "TASK VALID: YES",
    "TASK OPEN: YES",
    "TASK ACTIVE: NO",
    "MARK THE TASK ACTIVE",
    "TASK BLOCKED: NO",
];
const FRESH_WORKTREE = [
    "WORKTREE EXISTS: NO",
    "CREATE A WORKTREE",
    "AUTO GENERATE DOCS",
    "INIT SUBMODULES RECURSIVELY",
    "--------- planning ---------",
];
const PLAN_ACCEPTED = [
    "<-- AGENT --> PLAN THE TASK",
    "VALIDATE PLAN",
    "<-- AGENT --> CODEX REVIEWS PLAN",
    "CODEX REVIEW RESULT (ACCEPT,AMEND,SCRAP): ACCEPT",
];
const IMPLEMENT_AND_COMMIT = [
    "--------- implement and test ---------",
    "<-- AGENT --> IMPLEMENT TASK",
    "RECORD IMPL NOTES",
    "COMMIT (IF NEEDED)",
];
const TASK_TESTS_PASS = [
    "RUN TASK TESTS",
    "TESTS FAIL: NO",
];
const CODEX_ACCEPTS_TESTS = [
    "<-- AGENT --> CODEX REVIEWS TEST",
    "CODEX REVIEW TEST RESULT (FLAG, ACCEPT): ACCEPTED",
];
// The tail run each time the merge-retry loop is entered. LOCK SOURCE (and its banner) happen
// once per run, outside this loop, so a retry re-enters here rather than at LOCK SOURCE.
const REBASE_AND_SUITE_TAIL = [
    "REBASE IF NEEDED",
    "REBASE RESULT (OK, CONFLICT): OK",
    "COMMIT (IF NEEDED)",
    "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
    "RUN FULL SUITE RESULTS (PASS, FAIL): PASS",
    "CHECK FILE FENCE RESULT (PASS, FAIL): PASS",
];
const REBASE_CLEAN_AND_SUITE_GREEN = [
    "LOCK SOURCE",
    "--------- rebase and merge ---------",
    ...REBASE_AND_SUITE_TAIL,
];
const CLOSE_OUT = [
    EXIT_BANNER,
    "RECORD MERGE COMMIT HASHES",
    "WRITE EXIT TYPE: COMPLETED",
    "RECORD MODIFIED FILES",
    "CLEAN UP WORKTREES",
    "BUILD CLOSURE NOTE",
    "MARK INACTIVE",
    "MOVE TASK TO completedTasks.json",
    "REPORT THE CLOSURE NOTE",
    "STOP",
];
const MERGE_LANDS_AND_CLOSES = [
    "MERGE WORKTREES AND SUBMODULES RESULT (PASS, FAIL): PASS",
    ...CLOSE_OUT,
];

// The common exit chain, run by every exit reached after the task was marked active.
// The release box only names what is actually held: a lease exists once a worktree does,
// and the source lock is taken at the rebase box. "none" reaches neither.
// The exit-workflow banner is NOT included here: it is never indented, so callers place it
// themselves (via EXIT_BANNER) before wrapping the rest of this chain in indent() if needed.
const exitChain = (exitType: string, holds: "none" | "lease" | "lease-and-lock"): string[] => [
    `WRITE EXIT TYPE: ${exitType}`,
    "RECORD MODIFIED FILES",
    "MARK INACTIVE",
    ...(holds === "lease-and-lock" ? ["RELEASE THE WORKTREE LEASE AND SOURCE LOCK"] : []),
    ...(holds === "lease" ? ["RELEASE THE WORKTREE LEASE"] : []),
    `REPORT THE RUN'S EXIT TYPE AND NOTE: ${exitType}`,
    "STOP",
];

// Every path's inputs live in scripts/tracePipelinePaths.json, the same file the CLI reads,
// so a fixture the CLI can run is always a fixture a test has pinned.
const NAMED_PATHS = readNamedPaths();
const pathNamed = (name: string): PipelineDecisions => {
    const decisions = NAMED_PATHS[name];
    assert.ok(decisions !== undefined, `scripts/tracePipelinePaths.json has no path named "${name}"`);
    return decisions;
};

// ---------------------------------------------------------------- exits before the worktree

test("test_traceTaskPipeline_stopsAtInvalidNumberWithoutWritingToTasksJson", () => {
    // Scenario: the task number is in neither tasks.json nor completedTasks.json.
    // Steps: the validity box takes its "no" edge; there is no task record to write to,
    //   so the walk reports the exit type and stops without running the exit chain.
    const trace = traceTaskPipeline(pathNamed("invalid-number"));
    assert.deepEqual(trace, [
        "Run start: Task Num [42]",
        "--------- preamble ---------",
        "TASK VALID: NO",
        EXIT_BANNER,
        "REPORT EXIT TYPE AND NOTE: INVALID-NUMBER",
        "STOP",
    ]);
});

test("test_traceTaskPipeline_stopsAtNotOpenWhenTheTaskIsAlreadyCompleted", () => {
    // Scenario: the number is valid but the task lives in completedTasks.json.
    // Steps: validity passes, the open box takes its "no" edge, and the walk reports and stops.
    const trace = traceTaskPipeline(pathNamed("not-open"));
    assert.deepEqual(trace, [
        "Run start: Task Num [42]",
        "--------- preamble ---------",
        "TASK VALID: YES",
        "TASK OPEN: NO",
        EXIT_BANNER,
        "REPORT EXIT TYPE AND NOTE: NOT-OPEN",
        "STOP",
    ]);
});

test("test_traceTaskPipeline_stopsAtAlreadyActiveWhenTheTaskIsStillActive", () => {
    // Scenario: a previous run left the task active.
    // Steps: validity and open both pass; the active box takes its "yes" edge, so the task is
    //   never marked active a second time. That run belongs to another invocation, so the walk
    //   must report and stop without touching its record.
    const trace = traceTaskPipeline(pathNamed("already-active"));
    assert.deepEqual(trace, [
        "Run start: Task Num [42]",
        "--------- preamble ---------",
        "TASK VALID: YES",
        "TASK OPEN: YES",
        "TASK ACTIVE: YES",
        EXIT_BANNER,
        "REPORT EXIT TYPE AND NOTE: ALREADY-ACTIVE",
        "STOP",
    ]);
});

test("test_traceTaskPipeline_runsTheExitChainWhenTheTaskIsBlocked", () => {
    // Scenario: the task is marked active, then an open blocker is found.
    // Steps: marking it active started a run record. The blocked box takes its "yes"
    //   edge and the walk runs the full exit chain, which ends by releasing the holds.
    const trace = traceTaskPipeline(pathNamed("blocked"));
    assert.deepEqual(trace, [
        "Run start: Task Num [42]",
        "--------- preamble ---------",
        "TASK VALID: YES",
        "TASK OPEN: YES",
        "TASK ACTIVE: NO",
    "MARK THE TASK ACTIVE",
        "TASK BLOCKED: YES",
        EXIT_BANNER,
        ...exitChain("BLOCKED", "none"),
    ]);
});

// -------------------------------------------------------------------- the four worktree shapes

test("test_traceTaskPipeline_createsAWorktreeWhenNoneExists", () => {
    // Scenario: the task has never run, so no worktree is on disk.
    // Steps: the worktree box takes its "no" edge, one is created, docs are generated fresh,
    //   and submodules are initialised before planning. No loop repeats, so nothing is indented,
    //   and the agent-run boxes carry the agent marker.
    const trace = traceTaskPipeline(pathNamed("worktree-does-not-exist"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_reusesASafeExistingWorktree", () => {
    // Scenario: a worktree exists and passes the structural safety check.
    // Steps: the worktree box takes its "yes" edge, the safety box takes its "yes" edge, and
    //   the existing docs are updated rather than generated. The resumable box is never reached.
    const trace = traceTaskPipeline(pathNamed("safe-existing-worktree"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        "WORKTREE EXISTS: YES",
        "WORKTREE SAFE: YES",
        "UPDATE AUTO GENERATED DOCS",
        "INIT SUBMODULES RECURSIVELY",
        "--------- planning ---------",
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_keepsAnUnsafeWorktreeWhoseWorkIsResumable", () => {
    // Scenario: the worktree fails the safety check, but the previous run recorded where it
    //   stopped, so its work can still be resumed.
    // Steps: safety takes its "no" edge, the resumable box takes its "yes" edge, and the walk
    //   joins the safe path at "update auto generated docs" rather than resetting anything.
    const trace = traceTaskPipeline(pathNamed("unsafe-resumable-worktree"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        "WORKTREE EXISTS: YES",
        "WORKTREE SAFE: NO",
        "PREVIOUS WORK RESUMABLE: YES",
        "UPDATE AUTO GENERATED DOCS",
        "INIT SUBMODULES RECURSIVELY",
        "--------- planning ---------",
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_resetsAnUnsafeWorktreeWhoseWorkIsNotResumable", () => {
    // Scenario: the worktree is unsafe and the previous run recorded no resume point.
    // Steps: safety and resumable both take their "no" edges, the worktree is reset, and the
    //   walk rejoins the fresh path at "auto generate docs".
    const trace = traceTaskPipeline(pathNamed("unsafe-unresumable-worktree"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        "WORKTREE EXISTS: YES",
        "WORKTREE SAFE: NO",
        "PREVIOUS WORK RESUMABLE: NO",
        "RESET THE WORKTREE",
        "AUTO GENERATE DOCS",
        "INIT SUBMODULES RECURSIVELY",
        "--------- planning ---------",
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

// ------------------------------------------------------------------------------- the plan loop

test("test_traceTaskPipeline_replansWhenThePlanFileDoesNotValidate", () => {
    // Scenario: the first plan file is malformed. An invalid plan file counts as a scrap.
    // Steps: validation takes its "invalid" edge, which skips the codex call entirely and
    //   feeds the scrap counter, so the walk replans. The replan is a loop repeat, so its
    //   lines are indented. The second plan validates and is accepted.
    const trace = traceTaskPipeline(pathNamed("plan-file-invalid-then-valid"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        "<-- AGENT --> PLAN THE TASK",
        "VALIDATE PLAN",
        "PLAN INVALID: COUNTS AS A SCRAP",
        ...indent(PLAN_ACCEPTED),
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_appliesCodexAmendmentsBeforeImplementing", () => {
    // Scenario: codex accepts the plan's direction but asks for changes.
    // Steps: the review verdict is "amend", so a script applies codex's amendments to the plan
    //   before the implement box runs. No replanning happens, so nothing is indented.
    const trace = traceTaskPipeline(pathNamed("codex-amends-plan"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        "<-- AGENT --> PLAN THE TASK",
        "VALIDATE PLAN",
        "<-- AGENT --> CODEX REVIEWS PLAN",
        "CODEX REVIEW RESULT (ACCEPT,AMEND,SCRAP): AMEND",
        "APPLY CODEX AMENDMENTS TO THE PLAN",
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_replansOnceAfterCodexScrapsTheFirstPlan", () => {
    // Scenario: codex scraps the first plan, and accepts the replan.
    // Steps: the first review verdict is "scrap", so the walk returns to the plan box carrying
    //   codex's notes. The replan is indented as a loop repeat, and the run then continues at
    //   the outer level.
    const trace = traceTaskPipeline(pathNamed("codex-scraps-plan-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        "<-- AGENT --> PLAN THE TASK",
        "VALIDATE PLAN",
        "<-- AGENT --> CODEX REVIEWS PLAN",
        "CODEX REVIEW RESULT (ACCEPT,AMEND,SCRAP): SCRAP",
        ...indent(PLAN_ACCEPTED),
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_exitsPlanScrappedWhenCodexScrapsTwice", () => {
    // Scenario: codex scraps the plan on both attempts.
    // Steps: the first scrap sends the walk back to the plan box; the second scrap has no
    //   attempt left, so the walk runs the exit chain from inside the indented repeat. The
    //   exit-workflow banner itself is never indented, even though the chain around it is.
    const trace = traceTaskPipeline(pathNamed("plan-scrapped"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        "<-- AGENT --> PLAN THE TASK",
        "VALIDATE PLAN",
        "<-- AGENT --> CODEX REVIEWS PLAN",
        "CODEX REVIEW RESULT (ACCEPT,AMEND,SCRAP): SCRAP",
        ...indent([
            "<-- AGENT --> PLAN THE TASK",
            "VALIDATE PLAN",
            "<-- AGENT --> CODEX REVIEWS PLAN",
            "CODEX REVIEW RESULT (ACCEPT,AMEND,SCRAP): SCRAP",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("PLAN-SCRAPPED", "lease")),
    ]);
});

// ------------------------------------------------------------------------- the task-test loop

test("test_traceTaskPipeline_fixesTheCodebaseWhenTaskTestsFailOnce", () => {
    // Scenario: the task tests fail on the first run and pass after one codebase fix.
    // Steps: the failure edge leads to a codebase fix. The repair re-enters the loop at the
    //   commit box, never at the test box, because a repair is never tested until committed.
    //   That second pass is indented.
    const trace = traceTaskPipeline(pathNamed("task-tests-fail-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        "RUN TASK TESTS",
        "TESTS FAIL: YES",
        "<-- AGENT --> FIX THE CODEBASE",
        ...indent([
            "COMMIT (IF NEEDED)",
            ...TASK_TESTS_PASS,
            ...CODEX_ACCEPTS_TESTS,
        ]),
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_exitsTestsRedWhenTaskTestsFailTwice", () => {
    // Scenario: the task tests still fail after two codebase fixes.
    // Steps: the walk loops commit -> test -> fix twice, then has no attempt left and runs the
    //   exit chain with exit type tests-red from inside the indented repeat.
    const trace = traceTaskPipeline(pathNamed("tests-red"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        "RUN TASK TESTS",
        "TESTS FAIL: YES",
        "<-- AGENT --> FIX THE CODEBASE",
        ...indent([
            "COMMIT (IF NEEDED)",
            "RUN TASK TESTS",
            "TESTS FAIL: YES",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("TESTS-RED", "lease")),
    ]);
});

// -------------------------------------------------------------------- the codex test review

test("test_traceTaskPipeline_amendsTheTestsWhenCodexFlagsThemOnce", () => {
    // Scenario: the tests pass, but codex flags them against the task details and plan.
    // Steps: the flag edge leads to a test amendment, which re-enters at the commit box and
    //   runs the tests again, indented. On the second review codex accepts.
    const trace = traceTaskPipeline(pathNamed("codex-flags-tests-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        "<-- AGENT --> CODEX REVIEWS TEST",
        "CODEX REVIEW TEST RESULT (FLAG, ACCEPT): FLAG",
        "<-- AGENT --> AMEND THE TESTS",
        ...indent([
            "COMMIT (IF NEEDED)",
            ...TASK_TESTS_PASS,
            ...CODEX_ACCEPTS_TESTS,
        ]),
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_exitsTestsFlaggedWhenCodexFlagsTheTestsTwice", () => {
    // Scenario: codex flags the tests on both reviews.
    // Steps: the first flag amends the tests and re-runs them; the second flag has no attempt
    //   left, so the walk runs the exit chain with exit type tests-flagged.
    const trace = traceTaskPipeline(pathNamed("tests-flagged"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        "<-- AGENT --> CODEX REVIEWS TEST",
        "CODEX REVIEW TEST RESULT (FLAG, ACCEPT): FLAG",
        "<-- AGENT --> AMEND THE TESTS",
        ...indent([
            "COMMIT (IF NEEDED)",
            ...TASK_TESTS_PASS,
            "<-- AGENT --> CODEX REVIEWS TEST",
            "CODEX REVIEW TEST RESULT (FLAG, ACCEPT): FLAG",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("TESTS-FLAGGED", "lease")),
    ]);
});

// ------------------------------------------------------------------------------ the rebase loop

test("test_traceTaskPipeline_fixesConflictsWhenTheRebaseReportsThemOnce", () => {
    // Scenario: the rebase stops on conflicts once, and advances cleanly after the fix.
    // Steps: the conflict edge leads to a conflict fix, which re-enters at the commit box.
    //   This is the diagram's normal conflict flow, not a second pass, so nothing is indented.
    const trace = traceTaskPipeline(pathNamed("rebase-conflict-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "LOCK SOURCE",
        "--------- rebase and merge ---------",
        "REBASE IF NEEDED",
        "REBASE RESULT (OK, CONFLICT): CONFLICT",
        "<-- AGENT --> FIX CONFLICTS",
        "COMMIT (IF NEEDED)",
        "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
        "RUN FULL SUITE RESULTS (PASS, FAIL): PASS",
        "CHECK FILE FENCE RESULT (PASS, FAIL): PASS",
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_exitsRebaseStuckWhenConflictsRecurTwice", () => {
    // Scenario: the rebase reports conflicts on both attempts.
    // Steps: the first conflict is fixed and committed; the advance stops on new conflicts,
    //   which returns to the conflict box as an indented repeat. With no attempt left the
    //   walk exits rebase-stuck.
    const trace = traceTaskPipeline(pathNamed("rebase-stuck"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "LOCK SOURCE",
        "--------- rebase and merge ---------",
        "REBASE IF NEEDED",
        "REBASE RESULT (OK, CONFLICT): CONFLICT",
        "<-- AGENT --> FIX CONFLICTS",
        "COMMIT (IF NEEDED)",
        "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): CONFLICTS",
        ...indent(["REBASE RESULT (OK, CONFLICT): CONFLICT"]),
        EXIT_BANNER,
        ...indent(exitChain("REBASE-STUCK", "lease-and-lock")),
    ]);
});

test("test_traceTaskPipeline_returnsToTheConflictBoxWhenTheAdvanceStopsOnNewConflicts", () => {
    // Scenario: the rebase starts clean, but advancing it uncovers new conflicts once.
    // Steps: the advance takes its "no" edge back to the conflict box as an indented repeat,
    //   which now reports a conflict, is fixed, committed, and advances to finished. The fence
    //   and merge boxes are outside that loop, so they return to the outer level.
    const trace = traceTaskPipeline(pathNamed("advance-uncovers-conflicts"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "LOCK SOURCE",
        "--------- rebase and merge ---------",
        "REBASE IF NEEDED",
        "REBASE RESULT (OK, CONFLICT): OK",
        "COMMIT (IF NEEDED)",
        "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): CONFLICTS",
        ...indent([
            "REBASE RESULT (OK, CONFLICT): CONFLICT",
            "<-- AGENT --> FIX CONFLICTS",
            "COMMIT (IF NEEDED)",
            "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
            "RUN FULL SUITE RESULTS (PASS, FAIL): PASS",
        ]),
        "CHECK FILE FENCE RESULT (PASS, FAIL): PASS",
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

// ------------------------------------------------------------------------- the full-suite loop

test("test_traceTaskPipeline_fixesTheCodebaseWhenTheFullSuiteFailsOnce", () => {
    // Scenario: the full suite fails once and passes after one codebase fix.
    // Steps: the failure edge leads to a codebase fix, which re-enters at the commit box and
    //   advances the rebase again before the suite is re-run, all indented as a repeat.
    const trace = traceTaskPipeline(pathNamed("full-suite-fails-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "LOCK SOURCE",
        "--------- rebase and merge ---------",
        "REBASE IF NEEDED",
        "REBASE RESULT (OK, CONFLICT): OK",
        "COMMIT (IF NEEDED)",
        "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
        "RUN FULL SUITE RESULTS (PASS, FAIL): FAIL",
        "<-- AGENT --> FIX THE CODEBASE",
        ...indent([
            "COMMIT (IF NEEDED)",
            "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
            "RUN FULL SUITE RESULTS (PASS, FAIL): PASS",
        ]),
        "CHECK FILE FENCE RESULT (PASS, FAIL): PASS",
        ...MERGE_LANDS_AND_CLOSES,
    ]);
});

test("test_traceTaskPipeline_exitsSuiteRedWhenTheFullSuiteFailsTwice", () => {
    // Scenario: the full suite still fails after two codebase fixes.
    // Steps: the walk loops commit -> advance -> suite -> fix twice, then exits suite-red from
    //   inside the indented repeat.
    const trace = traceTaskPipeline(pathNamed("suite-red"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "LOCK SOURCE",
        "--------- rebase and merge ---------",
        "REBASE IF NEEDED",
        "REBASE RESULT (OK, CONFLICT): OK",
        "COMMIT (IF NEEDED)",
        "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
        "RUN FULL SUITE RESULTS (PASS, FAIL): FAIL",
        "<-- AGENT --> FIX THE CODEBASE",
        ...indent([
            "COMMIT (IF NEEDED)",
            "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
            "RUN FULL SUITE RESULTS (PASS, FAIL): FAIL",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("SUITE-RED", "lease-and-lock")),
    ]);
});

// ------------------------------------------------------------------------------- fence and merge

test("test_traceTaskPipeline_exitsFenceViolationWhenAStepChangedAFileTheTaskDoesNotOwn", () => {
    // Scenario: the suite is green, but a step touched a file outside the task's owned files.
    // Steps: the fence box takes its "no" edge. There is no retry for a fence violation, so
    //   the walk runs the exit chain immediately, at the outer level.
    const trace = traceTaskPipeline(pathNamed("fence-violation"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "LOCK SOURCE",
        "--------- rebase and merge ---------",
        "REBASE IF NEEDED",
        "REBASE RESULT (OK, CONFLICT): OK",
        "COMMIT (IF NEEDED)",
        "ADVANCE REBASE RESULT (FINISHED, CONFLICTS): FINISHED",
        "RUN FULL SUITE RESULTS (PASS, FAIL): PASS",
        "CHECK FILE FENCE RESULT (PASS, FAIL): FAIL",
        EXIT_BANNER,
        ...exitChain("FENCE-VIOLATION", "lease-and-lock"),
    ]);
});

test("test_traceTaskPipeline_rebasesAndRetriesWhenTheMergeDoesNotLandTheFirstTime", () => {
    // Scenario: another run landed first, so the merge fails once.
    // Steps: the merge box takes its "no" edge back to the rebase box, so the rebase, suite and
    //   fence tail runs again, indented. LOCK SOURCE happens once, so the retry does not repeat
    //   it. The second merge lands, and the close-out boxes return to the outer level.
    const trace = traceTaskPipeline(pathNamed("merge-retry-then-lands"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        "MERGE WORKTREES AND SUBMODULES RESULT (PASS, FAIL): FAIL",
        ...indent([
            ...REBASE_AND_SUITE_TAIL,
            "MERGE WORKTREES AND SUBMODULES RESULT (PASS, FAIL): PASS",
        ]),
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_exitsMergeFailedWhenTheMergeDoesNotLandTwice", () => {
    // Scenario: the merge fails on both attempts.
    // Steps: the first failure re-runs the rebase tail indented; the second failure has no
    //   attempt left, so the walk runs the exit chain with exit type merge-failed.
    const trace = traceTaskPipeline(pathNamed("merge-failed"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...REBASE_CLEAN_AND_SUITE_GREEN,
        "MERGE WORKTREES AND SUBMODULES RESULT (PASS, FAIL): FAIL",
        ...indent([
            ...REBASE_AND_SUITE_TAIL,
            "MERGE WORKTREES AND SUBMODULES RESULT (PASS, FAIL): FAIL",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("MERGE-FAILED", "lease-and-lock")),
    ]);
});

// ------------------------------------------------------------------------------ coverage guards

test("test_traceTaskPipeline_reachesEveryExitTypeInTheDiagramAcrossTheNamedPaths", () => {
    // Scenario: the diagram lists thirteen exit types. run-failed is deliberately undrawn — it
    //   can leave any green box — so twelve are reachable by walking edges.
    // Steps: walk every path in scripts/tracePipelinePaths.json, collect the exit type each one
    //   ends on, and assert the set matches the diagram's list. Banner lines never carry an exit
    //   type, so they fall out of this scan on their own. A new exit type in the diagram, or a
    //   fixture that reaches no exit at all, fails this test.
    const reached = new Set<string>();
    for (const [name, decisions] of Object.entries(NAMED_PATHS)) {
        const exitLine = traceTaskPipeline(decisions)
            .map((line) => line.trimStart())
            .find((line) => line.startsWith("REPORT EXIT TYPE AND NOTE: ") || line.startsWith("WRITE EXIT TYPE: "));
        assert.ok(exitLine !== undefined, `path "${name}" walked off the end without reaching an exit`);
        reached.add(exitLine.split(": ")[1]!);
    }

    assert.deepEqual([...reached].sort(), [
        "ALREADY-ACTIVE",
        "BLOCKED",
        "COMPLETED",
        "FENCE-VIOLATION",
        "INVALID-NUMBER",
        "MERGE-FAILED",
        "NOT-OPEN",
        "PLAN-SCRAPPED",
        "REBASE-STUCK",
        "SUITE-RED",
        "TESTS-FLAGGED",
        "TESTS-RED",
    ]);
});

test("test_traceTaskPipeline_marksEveryAgentRunBoxAndNoScriptBox", () => {
    // Scenario: plans/diagram/pipeline.mmd paints eight nodes yellow — the boxes an agent runs
    //   rather than a script. Two of them, FIXT and FIXC, are both "fix the codebase", so the
    //   marked set holds seven distinct names.
    // Steps: walk every named path, keep the lines carrying the marker, strip the marker and the
    //   indent, and assert the set of marked names is exactly the diagram's yellow set. Banner
    //   lines never carry the agent marker, so they fall out of this scan on their own.
    const marked = new Set<string>();
    for (const decisions of Object.values(NAMED_PATHS)) {
        for (const line of traceTaskPipeline(decisions)) {
            if (line.trimStart().startsWith("<-- AGENT --> ")) marked.add(line.trimStart().replace("<-- AGENT --> ", ""));
        }
    }

    assert.deepEqual([...marked].sort(), [
        "AMEND THE TESTS",
        "CODEX REVIEWS PLAN",
        "CODEX REVIEWS TEST",
        "FIX CONFLICTS",
        "FIX THE CODEBASE",
        "IMPLEMENT TASK",
        "PLAN THE TASK",
    ]);
});
