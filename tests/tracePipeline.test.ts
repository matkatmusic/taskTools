// Behavioral checks for tracePipeline.ts: the box-by-box walk of plans/diagram/pipeline.mmd
// for one set of decision outcomes. One test per path the pipeline can take.
// Every expected line below is the diagram node's verbatim label (its `<br/>` line breaks
// joined back to one line by mmdGraph's parser), not hand-written wording.
// Run alone: node --test tests/tracePipeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { traceTaskPipeline, readNamedPaths, type PipelineDecisions, type ReceiptName } from "../scripts/tracePipeline.ts";

// A repeat of a loop is indented one level, so a second pass is visible without counting lines.
const indent = (lines: string[], level = 1): string[] => lines.map((line) => "  ".repeat(level) + line);

const AGENT = "<-- AGENT -->";

// Sub-pipeline boundary banners. Pushed directly by the tracer, so they are never indented,
// even when the surrounding lines sit inside a loop repeat.
const PREAMBLE_BANNER = "--------- preamble ---------";
const PLANNING_BANNER = "--------- planning ---------";
const IMPLEMENT_BANNER = "--------- implement and test ---------";
const REBASE_BANNER = "--------- rebase and merge ---------";
const EXIT_BANNER = "--------- exit workflow ---------";

// Every receipt's field list, the diagram's verbatim "Receipt: { ... }" label.
const RECEIPT_FIELDS: Record<ReceiptName, string> = {
    "active task": "{ active task, initialized worktree }",
    "plan file": "{ plan file: task, revision, sections[ id, title, body ] }",
    "codex review": "{ codex review: verdict, notes, amendments[] }",
    "finished plan": "{ plan file }",
    "fix the codebase": "{ fixed }",
    "test review": "{ flagged, reviewer, test review file }",
    "amend tests": "{ amended }",
    "finished implementation": "{ finished implementation, source repo lock }",
    "conflict fix": "{ resolved, unresolvedPaths }",
    "fix the full suite": "{ fixed }",
    merge: "{ merge commit hashes, modified files }",
};

// The diagram's agent-run label for the full-suite fix, distinct from the task-test fix.
const FIX_THE_CODEBASE_FOR_SUITE = "fix the codebase so the full suite passes";

// The diagram's verbatim "is the ... receipt structure valid?" label per receipt. The cluster's
// base name and its validity diamond do not always match — see RECEIPT_NODES in tracePipeline.ts.
const RECEIPT_VALID_QUESTION: Record<ReceiptName, string> = {
    "active task": "is the active task receipt structure valid?",
    "plan file": "is the plan file structure valid?",
    "codex review": "is the review file structure valid?",
    "finished plan": "is the finished plan receipt structure valid?",
    "fix the codebase": "is the fix receipt structure valid?",
    "test review": "is the test review receipt structure valid?",
    "amend tests": "is the amendment receipt structure valid?",
    "finished implementation": "is the finished implementation receipt structure valid?",
    "conflict fix": "is the conflict fix receipt structure valid?",
    "fix the full suite": "is the suite fix receipt structure valid?",
    merge: "is the merge receipt structure valid?",
};

// Output -> receipt -> "is the ... valid?: YES" -> output -> the same receipt, printed again.
// The diagrams give the post-validation output and receipt the exact same label as the
// pre-validation pair — there is no "(TRUSTED)" marker drawn anywhere.
const receiptOk = (name: ReceiptName): string[] => {
    const fields = `Receipt: ${RECEIPT_FIELDS[name]}`;
    return ["Output", fields, `${RECEIPT_VALID_QUESTION[name]}: YES`, "Output", fields];
};
// The structure check fails: no trusted receipt is ever emitted, and the run goes to the exit chain.
const receiptFail = (name: ReceiptName): string[] => {
    const fields = `Receipt: ${RECEIPT_FIELDS[name]}`;
    return ["Output", fields, `${RECEIPT_VALID_QUESTION[name]}: NO`];
};

// Shared literal fragments. These are expected OUTPUT, not logic — each is a run of lines that
// several paths quote verbatim, kept in one place so a wording change is a one-line edit.
const ACTIVE_AND_UNBLOCKED = [
    "Run start: Task Num [42]",
    PREAMBLE_BANNER,
    "is task number valid?: YES",
    "is task open?: YES",
    "is the task active?: NO",
    "Try: mark the task active in tasks.json",
    "is task blocked?: NO",
];
const FRESH_WORKTREE_STEPS = ["does a worktree exist?: NO", "create a worktree", "auto generate docs", "init submodules recursively"];
const FRESH_WORKTREE = [...FRESH_WORKTREE_STEPS, ...receiptOk("active task"), PLANNING_BANNER];

const PLAN_THE_TASK = [`${AGENT} plan the task`, ...receiptOk("plan file")];
const CODEX_REVIEWS_PLAN = [`${AGENT} codex reviews the plan`, ...receiptOk("codex review")];
// The plan loop's happy path: one plan, one review, accepted first time.
const PLAN_ACCEPTED = [
    ...PLAN_THE_TASK,
    ...CODEX_REVIEWS_PLAN,
    "what is the review verdict?: ACCEPT",
    ...receiptOk("finished plan"),
    IMPLEMENT_BANNER,
];

const IMPLEMENT_AND_COMMIT = [`${AGENT} implement task`, "record implementation notes file to tasks.json", "commit if needed"];
const TASK_TESTS_PASS = ["Try: run task tests", "do the tests fail?: NO"];
const CODEX_ACCEPTS_TESTS = [`${AGENT} codex reviews tests against task details and plan file`, ...receiptOk("test review"), "are the tests flagged?: NO"];

// Both source-repo two-strike loops taking their "yes" edge first try, ending at the rebase banner.
const LOCK_SOURCE_CLEAN = [
    "can the source repo be locked?: YES",
    "Try: lock the source repo",
    "did locking the source repo succeed?: YES",
    ...receiptOk("finished implementation"),
    REBASE_BANNER,
];

// The tail run each time the merge-retry loop is entered: a clean rebase, a finished advance,
// a green suite, and a held fence. LOCK SOURCE happens once, outside this loop.
const REBASE_SUITE_AND_FENCE_CLEAN = [
    "Try: rebase onto the target branch if needed",
    "did the rebase report conflicts?: NO",
    "commit if needed",
    "Try: continue replaying commits on top of the target branch",
    "is the rebase finished?: YES",
    "Try: run the full suite",
    "do all tests pass?: YES",
    "did every change stay inside the task's owned files?: YES",
];
const MERGE_LANDS = ["Try: merge worktrees and submodules, no fast-forward", "did the merge land?: YES"];

const CLOSE_OUT = [
    EXIT_BANNER,
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
// The full happy-path tail from the rebase banner to the finished run.
const REBASE_CLEAN_MERGE_AND_CLOSE = [REBASE_BANNER, ...REBASE_SUITE_AND_FENCE_CLEAN, ...MERGE_LANDS, ...receiptOk("merge"), ...CLOSE_OUT];

// The common exit chain, run by every exit reached after the task was marked active. The
// diagram draws a decision for whether a worktree was created, then (only if so) a second
// decision for whether the source repo was locked, so the release line names only what is
// actually held: nothing before a worktree exists, the lease only before the lock, both after.
// The exit-workflow banner is NOT included here: it is never indented, so callers place it
// themselves before wrapping the rest of this chain in indent() if needed.
const exitChain = (exitType: string, holds: "none" | "lease" | "lease-and-lock"): string[] => [
    `write exit type and exit notes to tasks.json: ${exitType}`,
    "record modified files to tasks.json",
    "mark task inactive in tasks.json",
    `was a worktree created?: ${holds === "none" ? "NO" : "YES"}`,
    ...(holds === "none"
        ? ["nothing to release"]
        : holds === "lease"
          ? ["was the source repo locked?: NO", "release the worktree lease"]
          : ["was the source repo locked?: YES", "release the worktree lease and the source lock"]),
    `report the run's exit type and note: ${exitType}`,
    "stop",
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
        PREAMBLE_BANNER,
        "is task number valid?: NO",
        EXIT_BANNER,
        "report the exit type and note: INVALID-NUMBER",
        "stop",
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
        PREAMBLE_BANNER,
        "is task number valid?: YES",
        "is task open?: YES",
        "is the task active?: YES",
        EXIT_BANNER,
        "report the exit type and note: ALREADY-ACTIVE",
        "stop",
    ]);
});

test("test_traceTaskPipeline_runsTheExitChainWhenTheTaskIsBlocked", () => {
    // Scenario: the task is marked active, then an open blocker is found.
    // Steps: marking it active started a run record. The blocked box takes its "yes"
    //   edge and the walk runs the full exit chain, which ends by releasing the holds.
    //   No worktree exists yet, so nothing is released.
    const trace = traceTaskPipeline(pathNamed("blocked"));
    assert.deepEqual(trace, [...ACTIVE_AND_UNBLOCKED.slice(0, -1), "is task blocked?: YES", EXIT_BANNER, ...exitChain("BLOCKED", "none")]);
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
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN.slice(0),
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_reusesASafeExistingWorktree", () => {
    // Scenario: a worktree exists and passes the structural safety check.
    // Steps: the worktree box takes its "yes" edge, the safety box takes its "yes" edge, and
    //   the existing docs are updated rather than generated. The resumable box is never reached.
    const trace = traceTaskPipeline(pathNamed("safe-existing-worktree"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        "does a worktree exist?: YES",
        "is the worktree safe to use?: YES",
        "update auto generated docs",
        "init submodules recursively",
        ...receiptOk("active task"),
        PLANNING_BANNER,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
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
        "does a worktree exist?: YES",
        "is the worktree safe to use?: NO",
        "is the previous run's work resumable?: YES",
        "update auto generated docs",
        "init submodules recursively",
        ...receiptOk("active task"),
        PLANNING_BANNER,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_resetsAnUnsafeWorktreeWhoseWorkIsNotResumable", () => {
    // Scenario: the worktree is unsafe and the previous run recorded no resume point.
    // Steps: safety and resumable both take their "no" edges, the worktree is reset, and the
    //   walk rejoins the fresh path at "auto generate docs".
    const trace = traceTaskPipeline(pathNamed("unsafe-unresumable-worktree"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        "does a worktree exist?: YES",
        "is the worktree safe to use?: NO",
        "is the previous run's work resumable?: NO",
        "reset the worktree",
        "auto generate docs",
        "init submodules recursively",
        ...receiptOk("active task"),
        PLANNING_BANNER,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
    ]);
});

// ------------------------------------------------------------------------------- the plan loop

test("test_traceTaskPipeline_appliesCodexAmendmentsOnceThenAccepts", () => {
    // Scenario: codex accepts the plan's direction but asks for changes; the second review accepts.
    // Steps: the first verdict is AMEND, so a script applies the amendments and re-enters at
    //   "codex reviews the plan", indented as a loop repeat. The second review accepts, ending
    //   the loop; the walk returns to the outer level for the finished-plan receipt.
    const trace = traceTaskPipeline(pathNamed("codex-amends-plan-then-accepts"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_THE_TASK,
        ...CODEX_REVIEWS_PLAN,
        "what is the review verdict?: AMEND",
        "Try: script applies codex amendments to the plan",
        "2 amend rounds done?: NO",
        ...indent([...CODEX_REVIEWS_PLAN, "what is the review verdict?: ACCEPT"]),
        ...receiptOk("finished plan"),
        IMPLEMENT_BANNER,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_exitsThePlanLoopAfterTwoAmendRounds", () => {
    // Scenario: codex asks for amendments on both reviews it is allowed. Two amend rounds is
    //   not a failure: the loop simply stops asking and moves on with the twice-amended plan.
    // Steps: the first AMEND re-enters at "codex reviews the plan", indented once. The second
    //   AMEND has no round left, so the loop breaks from inside that same indented repeat.
    const trace = traceTaskPipeline(pathNamed("codex-amends-plan-twice"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_THE_TASK,
        ...CODEX_REVIEWS_PLAN,
        "what is the review verdict?: AMEND",
        "Try: script applies codex amendments to the plan",
        "2 amend rounds done?: NO",
        ...indent([
            ...CODEX_REVIEWS_PLAN,
            "what is the review verdict?: AMEND",
            "Try: script applies codex amendments to the plan",
            "2 amend rounds done?: YES",
        ]),
        ...receiptOk("finished plan"),
        IMPLEMENT_BANNER,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_replansOnceAfterCodexScrapsTheFirstPlan", () => {
    // Scenario: codex scraps the first plan, and accepts the replan.
    // Steps: the first review verdict is SCRAP, so the walk returns to the plan box carrying
    //   codex's notes. The replan is indented as a loop repeat, and the run then continues at
    //   the outer level.
    const trace = traceTaskPipeline(pathNamed("codex-scraps-plan-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_THE_TASK,
        ...CODEX_REVIEWS_PLAN,
        "what is the review verdict?: SCRAP",
        "First Time Scrap?: YES",
        "script adds the codex scrap notes to the task brief",
        ...indent([...PLAN_THE_TASK, ...CODEX_REVIEWS_PLAN, "what is the review verdict?: ACCEPT"]),
        ...receiptOk("finished plan"),
        IMPLEMENT_BANNER,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
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
        ...PLAN_THE_TASK,
        ...CODEX_REVIEWS_PLAN,
        "what is the review verdict?: SCRAP",
        "First Time Scrap?: YES",
        "script adds the codex scrap notes to the task brief",
        ...indent([
            ...PLAN_THE_TASK,
            ...CODEX_REVIEWS_PLAN,
            "what is the review verdict?: SCRAP",
            "First Time Scrap?: NO",
            "Second Time Scrap",
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
        "Try: run task tests",
        "do the tests fail?: YES",
        "First fail?: YES",
        `${AGENT} fix the codebase`,
        ...receiptOk("fix the codebase"),
        ...indent(["commit if needed", ...TASK_TESTS_PASS, ...CODEX_ACCEPTS_TESTS]),
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
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
        "Try: run task tests",
        "do the tests fail?: YES",
        "First fail?: YES",
        `${AGENT} fix the codebase`,
        ...receiptOk("fix the codebase"),
        ...indent(["commit if needed", "Try: run task tests", "do the tests fail?: YES", "First fail?: NO", "2nd fail"]),
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
        `${AGENT} codex reviews tests against task details and plan file`,
        ...receiptOk("test review"),
        "are the tests flagged?: YES",
        "First flagging?: YES",
        `${AGENT} amend the tests`,
        ...receiptOk("amend tests"),
        ...indent(["commit if needed", ...TASK_TESTS_PASS, ...CODEX_ACCEPTS_TESTS]),
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
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
        `${AGENT} codex reviews tests against task details and plan file`,
        ...receiptOk("test review"),
        "are the tests flagged?: YES",
        "First flagging?: YES",
        `${AGENT} amend the tests`,
        ...receiptOk("amend tests"),
        ...indent([
            "commit if needed",
            ...TASK_TESTS_PASS,
            `${AGENT} codex reviews tests against task details and plan file`,
            ...receiptOk("test review"),
            "are the tests flagged?: YES",
            "First flagging?: NO",
            "2nd flagging",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("TESTS-FLAGGED", "lease")),
    ]);
});

// ------------------------------------------------------------------------ the source repo lock

test("test_traceTaskPipeline_waitsOnceWhenTheSourceRepoIsHeldThenLocks", () => {
    // Scenario: another run holds the source repo once; it is free by the second check.
    // Steps: the free box takes its "no" edge, the walk waits, and the retry is indented. The
    //   lock then succeeds on the first try.
    const trace = traceTaskPipeline(pathNamed("source-repo-held-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "can the source repo be locked?: NO",
        "First time held?: YES",
        "Try: wait",
        ...indent(["can the source repo be locked?: YES", "Try: lock the source repo", "did locking the source repo succeed?: YES"]),
        ...receiptOk("finished implementation"),
        ...REBASE_CLEAN_MERGE_AND_CLOSE,
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheSourceRepoStaysHeldTwice", () => {
    // Scenario: the source repo is still held on the second check.
    // Steps: the first wait is indented once; the second "held" has no attempt left, so the
    //   walk exits run-failed, holding only the worktree lease since the lock was never taken.
    const trace = traceTaskPipeline(pathNamed("source-repo-held-twice"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "can the source repo be locked?: NO",
        "First time held?: YES",
        "Try: wait",
        ...indent(["can the source repo be locked?: NO", "First time held?: NO", "2nd time held"]),
        EXIT_BANNER,
        ...indent(exitChain("RUN-FAILED", "lease")),
    ]);
});

test("test_traceTaskPipeline_waitsOnceWhenLockingLosesTheRaceThenSucceeds", () => {
    // Scenario: the repo is free, but taking the lock loses a race once; it succeeds on retry.
    // Steps: the locking box takes its "no" edge, the walk waits, and the retry re-enters at
    //   "source repo can be locked", indented.
    const trace = traceTaskPipeline(pathNamed("lock-race-lost-once"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "can the source repo be locked?: YES",
        "Try: lock the source repo",
        "did locking the source repo succeed?: NO",
        "First lock failure?: YES",
        "Try: wait",
        ...indent(["can the source repo be locked?: YES", "Try: lock the source repo", "did locking the source repo succeed?: YES"]),
        ...receiptOk("finished implementation"),
        ...REBASE_CLEAN_MERGE_AND_CLOSE,
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenLockingLosesTheRaceTwice", () => {
    // Scenario: taking the lock loses the race on both attempts.
    // Steps: the first failure waits and retries, indented; the second failure has no attempt
    //   left, so the walk exits run-failed holding only the lease, since the lock was never won.
    const trace = traceTaskPipeline(pathNamed("lock-race-lost-twice"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "can the source repo be locked?: YES",
        "Try: lock the source repo",
        "did locking the source repo succeed?: NO",
        "First lock failure?: YES",
        "Try: wait",
        ...indent([
            "can the source repo be locked?: YES",
            "Try: lock the source repo",
            "did locking the source repo succeed?: NO",
            "First lock failure?: NO",
            "2nd lock failure",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("RUN-FAILED", "lease")),
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
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: YES",
        "First conflict?: YES",
        `${AGENT} fix conflicts`,
        ...receiptOk("conflict fix"),
        "commit if needed",
        "Try: continue replaying commits on top of the target branch",
        "is the rebase finished?: YES",
        "Try: run the full suite",
        "do all tests pass?: YES",
        "did every change stay inside the task's owned files?: YES",
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_exitsRebaseStuckWhenTwoConflictFixesNeverAdvanceTheReplay", () => {
    // Scenario: the rebase stops on a conflict, the agent fixes it, the replay still does not
    //   finish, and the next check finds conflicts again. That is the second conflict, so the
    //   run exits rebase-stuck. Reaching this exit needs BOTH a second "conflict" rebase entry
    //   and a rebaseAdvance of "conflicts" — a fixture that advances to "finished" completes
    //   instead, which is what this fixture used to do.
    // Steps: walk the "rebase-stuck" path and assert the full line sequence, ending in the
    //   exit chain with the lease and the source lock both released.
    const trace = traceTaskPipeline(pathNamed("rebase-stuck"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: YES",
        "First conflict?: YES",
        `${AGENT} fix conflicts`,
        ...receiptOk("conflict fix"),
        "commit if needed",
        "Try: continue replaying commits on top of the target branch",
        "is the rebase finished?: NO",
        "  did the rebase report conflicts?: YES",
        "  First conflict?: NO",
        "  2nd conflict?",
        EXIT_BANNER,
        ...indent(exitChain("REBASE-STUCK", "lease-and-lock")),
    ]);
});

test("test_traceTaskPipeline_returnsToTheConflictBoxWhenTheAdvanceStopsWithoutFinishing", () => {
    // Scenario: the rebase starts clean, but advancing it does not finish the first time and
    //   the replay reports no new conflicts either; it finishes cleanly the second time round.
    // Steps: the advance takes its "no" edge back into the tail loop, indented once. The
    //   re-checked conflict box, commit, and advance all run again at that depth before the
    //   suite, fence and merge boxes return to the outer level.
    const trace = traceTaskPipeline(pathNamed("advance-uncovers-conflicts"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: NO",
        "commit if needed",
        "Try: continue replaying commits on top of the target branch",
        "is the rebase finished?: NO",
        ...indent([
            "did the rebase report conflicts?: NO",
            "commit if needed",
            "Try: continue replaying commits on top of the target branch",
            "is the rebase finished?: YES",
            "Try: run the full suite",
            "do all tests pass?: YES",
        ]),
        "did every change stay inside the task's owned files?: YES",
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
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
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: NO",
        "commit if needed",
        "Try: continue replaying commits on top of the target branch",
        "is the rebase finished?: YES",
        "Try: run the full suite",
        "do all tests pass?: NO",
        "First suite failure?: YES",
        `${AGENT} ${FIX_THE_CODEBASE_FOR_SUITE}`,
        ...receiptOk("fix the full suite"),
        ...indent([
            "commit if needed",
            "Try: continue replaying commits on top of the target branch",
            "is the rebase finished?: YES",
            "Try: run the full suite",
            "do all tests pass?: YES",
        ]),
        "did every change stay inside the task's owned files?: YES",
        ...MERGE_LANDS,
        ...receiptOk("merge"),
        ...CLOSE_OUT,
    ]);
});

test("test_traceTaskPipeline_exitsSuiteRedWhenTheFullSuiteFailsTwice", () => {
    // Scenario: the full suite still fails after two codebase fixes.
    // Steps: the walk loops commit -> advance -> suite -> fix twice, then exits suite-red from
    //   inside the indented repeat, holding both the lease and the source lock.
    const trace = traceTaskPipeline(pathNamed("suite-red"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: NO",
        "commit if needed",
        "Try: continue replaying commits on top of the target branch",
        "is the rebase finished?: YES",
        "Try: run the full suite",
        "do all tests pass?: NO",
        "First suite failure?: YES",
        `${AGENT} ${FIX_THE_CODEBASE_FOR_SUITE}`,
        ...receiptOk("fix the full suite"),
        ...indent([
            "commit if needed",
            "Try: continue replaying commits on top of the target branch",
            "is the rebase finished?: YES",
            "Try: run the full suite",
            "do all tests pass?: NO",
            "First suite failure?: NO",
            "2nd suite failure?",
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
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: NO",
        "commit if needed",
        "Try: continue replaying commits on top of the target branch",
        "is the rebase finished?: YES",
        "Try: run the full suite",
        "do all tests pass?: YES",
        "did every change stay inside the task's owned files?: NO",
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
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        "Try: merge worktrees and submodules, no fast-forward",
        "did the merge land?: NO",
        "First merge failure?: YES",
        ...indent([...REBASE_SUITE_AND_FENCE_CLEAN, "Try: merge worktrees and submodules, no fast-forward", "did the merge land?: YES"]),
        ...receiptOk("merge"),
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
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        "Try: merge worktrees and submodules, no fast-forward",
        "did the merge land?: NO",
        "First merge failure?: YES",
        ...indent([
            ...REBASE_SUITE_AND_FENCE_CLEAN,
            "Try: merge worktrees and submodules, no fast-forward",
            "did the merge land?: NO",
            "First merge failure?: NO",
            "2nd merge failure?",
        ]),
        EXIT_BANNER,
        ...indent(exitChain("MERGE-FAILED", "lease-and-lock")),
    ]);
});

// --------------------------------------------------------------------- malformed receipts

test("test_traceTaskPipeline_exitsRunFailedWhenTheActiveTaskReceiptIsMalformed", () => {
    // Scenario: the preamble's own receipt fails its structure check.
    // Steps: the "is the active task receipt structure valid?" box takes its "no" edge. No
    //   trusted receipt is ever output, and the run goes straight to the exit chain as run-failed.
    const trace = traceTaskPipeline(pathNamed("malformed-active-task-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE_STEPS,
        ...receiptFail("active task"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenThePlanFileReceiptIsMalformed", () => {
    // Scenario: the first plan file's receipt fails its structure check.
    // Steps: codex is never called; the walk exits run-failed straight from the plan box.
    const trace = traceTaskPipeline(pathNamed("malformed-plan-file-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        `${AGENT} plan the task`,
        ...receiptFail("plan file"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheCodexReviewReceiptIsMalformed", () => {
    // Scenario: codex's review receipt fails its structure check.
    // Steps: the verdict is never read; the walk exits run-failed from the review box.
    const trace = traceTaskPipeline(pathNamed("malformed-codex-review-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_THE_TASK,
        `${AGENT} codex reviews the plan`,
        ...receiptFail("codex review"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheFinishedPlanReceiptIsMalformed", () => {
    // Scenario: the plan is accepted, but its finished-plan receipt fails its structure check.
    // Steps: the walk never reaches "implement and test"; it exits run-failed from the receipt.
    const trace = traceTaskPipeline(pathNamed("malformed-finished-plan-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_THE_TASK,
        ...CODEX_REVIEWS_PLAN,
        "what is the review verdict?: ACCEPT",
        ...receiptFail("finished plan"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheFixTheCodebaseReceiptIsMalformed", () => {
    // Scenario: the task tests fail once, and the codebase-fix receipt fails its structure check.
    // Steps: the fixed codebase is never trusted; the walk exits run-failed from the receipt.
    const trace = traceTaskPipeline(pathNamed("malformed-fix-the-codebase-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        "Try: run task tests",
        "do the tests fail?: YES",
        "First fail?: YES",
        `${AGENT} fix the codebase`,
        ...receiptFail("fix the codebase"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheTestReviewReceiptIsMalformed", () => {
    // Scenario: codex's test review receipt fails its structure check.
    // Steps: the flagged/accepted verdict is never read; the walk exits run-failed here.
    const trace = traceTaskPipeline(pathNamed("malformed-test-review-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        `${AGENT} codex reviews tests against task details and plan file`,
        ...receiptFail("test review"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheAmendTestsReceiptIsMalformed", () => {
    // Scenario: codex flags the tests once; the amendment's receipt fails its structure check.
    // Steps: the amended tests are never trusted; the walk exits run-failed from the receipt.
    const trace = traceTaskPipeline(pathNamed("malformed-amend-tests-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        `${AGENT} codex reviews tests against task details and plan file`,
        ...receiptOk("test review"),
        "are the tests flagged?: YES",
        "First flagging?: YES",
        `${AGENT} amend the tests`,
        ...receiptFail("amend tests"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheFinishedImplementationReceiptIsMalformed", () => {
    // Scenario: the source repo lock is won, but the finished-implementation receipt fails.
    // Steps: the lock is already held at this point, so the exit chain releases it too.
    const trace = traceTaskPipeline(pathNamed("malformed-finished-implementation-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        "can the source repo be locked?: YES",
        "Try: lock the source repo",
        "did locking the source repo succeed?: YES",
        ...receiptFail("finished implementation"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease-and-lock"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheConflictFixReceiptIsMalformed", () => {
    // Scenario: the rebase reports a conflict, and the conflict fix's receipt fails.
    // Steps: the resolved conflict is never trusted; the walk exits run-failed, holding both
    //   the lease and the source lock taken during "implement and test".
    const trace = traceTaskPipeline(pathNamed("malformed-conflict-fix-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: YES",
        "First conflict?: YES",
        `${AGENT} fix conflicts`,
        ...receiptFail("conflict fix"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease-and-lock"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheFixTheFullSuiteReceiptIsMalformed", () => {
    // Scenario: the full suite fails once, and the codebase-fix receipt fails its structure check.
    // Steps: the fixed codebase is never trusted; the walk exits run-failed from the receipt.
    const trace = traceTaskPipeline(pathNamed("malformed-fix-the-full-suite-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        "Try: rebase onto the target branch if needed",
        "did the rebase report conflicts?: NO",
        "commit if needed",
        "Try: continue replaying commits on top of the target branch",
        "is the rebase finished?: YES",
        "Try: run the full suite",
        "do all tests pass?: NO",
        "First suite failure?: YES",
        `${AGENT} ${FIX_THE_CODEBASE_FOR_SUITE}`,
        ...receiptFail("fix the full suite"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease-and-lock"),
    ]);
});

test("test_traceTaskPipeline_exitsRunFailedWhenTheMergeReceiptIsMalformed", () => {
    // Scenario: the merge lands, but its own receipt fails its structure check.
    // Steps: the run never reaches "completed"; it exits run-failed from the merge receipt,
    //   holding both the lease and the source lock.
    const trace = traceTaskPipeline(pathNamed("malformed-merge-receipt"));
    assert.deepEqual(trace, [
        ...ACTIVE_AND_UNBLOCKED,
        ...FRESH_WORKTREE,
        ...PLAN_ACCEPTED,
        ...IMPLEMENT_AND_COMMIT,
        ...TASK_TESTS_PASS,
        ...CODEX_ACCEPTS_TESTS,
        ...LOCK_SOURCE_CLEAN,
        ...REBASE_SUITE_AND_FENCE_CLEAN,
        ...MERGE_LANDS,
        ...receiptFail("merge"),
        EXIT_BANNER,
        ...exitChain("RUN-FAILED", "lease-and-lock"),
    ]);
});

// ------------------------------------------------------------------------------ coverage guards

test("test_traceTaskPipeline_reachesEveryExitTypeTheNamedPathsCanReach", () => {
    // Scenario: plans/diagram/pipeline-rebaseMerge.mmd draws thirteen exit types, including
    //   rebase-stuck (two conflict fixes in a row that never advance). No named path in
    //   scripts/tracePipelinePaths.json currently drives rebaseAdvance to "conflicts" twice, so
    //   rebase-stuck is drawn but unreachable by the current fixture set — see the note below
    //   this test. Every OTHER exit type the diagram draws is reachable, and this guard checks
    //   that set stays exact: a new exit type in the diagram, or a fixture that reaches no exit
    //   type at all, fails this test.
    const reached = new Set<string>();
    for (const [name, decisions] of Object.entries(NAMED_PATHS)) {
        const lines = traceTaskPipeline(decisions).map((line) => line.trimStart());
        const completed = lines.includes("write exit type completed to tasks.json");
        const exitLine = lines.find(
            (line) => line.startsWith("report the exit type and note: ") || line.startsWith("write exit type and exit notes to tasks.json: "),
        );
        assert.ok(completed || exitLine !== undefined, `path "${name}" walked off the end without reaching an exit`);
        reached.add(completed ? "COMPLETED" : exitLine!.split(": ")[1]!);
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
        "RUN-FAILED",
        "SUITE-RED",
        "TESTS-FLAGGED",
        "TESTS-RED",
    ]);
});

test("test_traceTaskPipeline_marksEveryAgentRunBoxAndNoScriptBox", () => {
    // Scenario: the diagrams paint eight distinct boxes orange — the ones an agent runs rather
    //   than a script. The task-test fix and the full-suite fix are now two distinct boxes with
    //   distinct wording, so both appear in the marked set.
    // Steps: walk every named path, keep the lines carrying the marker, strip the marker and the
    //   indent, and assert the set of marked names is exactly the diagrams' agent set. Banner
    //   lines and receipt lines never carry the agent marker, so they fall out of this scan.
    const marked = new Set<string>();
    for (const decisions of Object.values(NAMED_PATHS)) {
        for (const line of traceTaskPipeline(decisions)) {
            if (line.trimStart().startsWith(`${AGENT} `)) marked.add(line.trimStart().replace(`${AGENT} `, ""));
        }
    }

    assert.deepEqual([...marked].sort(), [
        "amend the tests",
        "codex reviews tests against task details and plan file",
        "codex reviews the plan",
        "fix conflicts",
        "fix the codebase",
        FIX_THE_CODEBASE_FOR_SUITE,
        "implement task",
        "plan the task",
    ]);
});

test("test_traceTaskPipeline_validatesEveryReceiptNameAcrossTheNamedPaths", () => {
    // Scenario: the tracer validates eleven distinct receipts, each behind its own validity
    //   question now that the task-test fix and the full-suite fix have separate diagram
    //   clusters. This guard proves the named paths actually exercise every one of them (as a
    //   trusted "YES" at least once), so a receipt validator that silently stopped running would
    //   show up as a gap here.
    const ALL_RECEIPT_NAMES: ReceiptName[] = [
        "active task",
        "plan file",
        "codex review",
        "finished plan",
        "fix the codebase",
        "test review",
        "amend tests",
        "finished implementation",
        "conflict fix",
        "fix the full suite",
        "merge",
    ];

    const validated = new Set<string>();
    for (const decisions of Object.values(NAMED_PATHS)) {
        for (const line of traceTaskPipeline(decisions)) {
            const trimmed = line.trimStart();
            for (const name of ALL_RECEIPT_NAMES) {
                if (trimmed === `${RECEIPT_VALID_QUESTION[name]}: YES`) validated.add(name);
            }
        }
    }

    assert.deepEqual([...validated].sort(), [...ALL_RECEIPT_NAMES].sort());
});
