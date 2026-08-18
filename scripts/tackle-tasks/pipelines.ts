/*
  One exported function per plans/diagram/pipeline-<name>.mmd, so a diagram can be tested alone.

  generateTaskWorkflow.ts strips the types and splices this file into the workflow template.

  The sandbox forbids import, so the workflow and a test run these functions, never two copies.

  Every pipeline takes a context and returns where to go next, so none of them holds state.
*/

// The harness globals the workflow sandbox provides, and the label lookup the diagrams supply.
export type PipelineConfig = {
    task: number;
    emitter: string;
    worktree: string;
    projectRoot: string;
    sourceBranch: string;
    runId: string;
    fake: Record<string, unknown> | null | undefined;
    L: (id: string) => string;
    agent: (prompt: string, options: { label: string; schema: unknown }) => Promise<unknown>;
    log: (line: string) => void;
    phase: (title: string) => void;
};

export type PipelineContext = PipelineConfig & {
    trace: string[];
    depth: number;
    sourceLockHeld: boolean;
    agentVisits: Map<string, number>;
    planExtra: Record<string, unknown>;
    implementExtra: Record<string, unknown>;
    clarifyRounds: number;
    planReviews: number;
    testFixes: number;
    testReviews: number;
    conflictFixes: number;
    suiteFixes: number;
    mergeAttempts: number;
    plannerIndex: number;
    verdictIndex: number;
    testsIndex: number;
    flaggedIndex: number;
    lockIndex: number;
    conflictsIndex: number;
    finishedIndex: number;
    suiteIndex: number;
    publicationIndex: number;
};

// Where a pipeline sends the run: on to another pipeline, or out through an exit tail.
export type PipelineOutcome =
    | { next: string; done?: undefined }
    | { done: true; exitType: string; exitNote: string; workLanded: boolean };

export const MAX_ATTEMPTS = 2;

const INDENT = "  ";

const AGENT_FAILED_NOTE = "the agent returned nothing usable";

// Every counter starts at zero, because none of them is written to tasks.json.
export function createPipelineContext(config: PipelineConfig): PipelineContext {
    return {
        task: config.task,
        emitter: config.emitter,
        worktree: config.worktree,
        projectRoot: config.projectRoot,
        sourceBranch: config.sourceBranch,
        runId: config.runId,
        fake: config.fake,
        L: config.L,
        agent: config.agent,
        log: config.log,
        phase: config.phase,
        trace: [],
        depth: 0,
        sourceLockHeld: false,
        agentVisits: new Map(),
        planExtra: {},
        implementExtra: {},
        clarifyRounds: 0,
        planReviews: 0,
        testFixes: 0,
        testReviews: 0,
        conflictFixes: 0,
        suiteFixes: 0,
        mergeAttempts: 0,
        plannerIndex: 0,
        verdictIndex: 0,
        testsIndex: 0,
        flaggedIndex: 0,
        lockIndex: 0,
        conflictsIndex: 0,
        finishedIndex: 0,
        suiteIndex: 0,
        publicationIndex: 0,
    };
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

/*
  One diagram box, indented one level per repeat of a loop.
*/
export function step(ctx: PipelineContext, label: string, suffix?: string): string {
    const line = INDENT.repeat(ctx.depth) + (suffix === undefined ? label : `${label}: ${suffix}`);
    ctx.trace.push(line);
    ctx.log(line);
    return line;
}

/*
  A sub-pipeline boundary, one per plans/diagram/pipeline-<name>.mmd file. Never indented.
*/
export function banner(ctx: PipelineContext, name: string): string {
    const line = `--------- ${name} ---------`;
    ctx.trace.push(line);
    ctx.log(line);
    return line;
}

export function yesNo(value: unknown): string {
    return value ? "YES" : "NO";
}

/*
  Reads one attempt's outcome; past the end of the list the last entry repeats.
*/
export function attempt<T>(outcomes: T[], index: number): T {
    return outcomes[Math.min(index, outcomes.length - 1)] as T;
}

export function isFake(ctx: PipelineContext): boolean {
    return ctx.fake !== null && ctx.fake !== undefined;
}

/*
  The whole prompt for an [S] box, per workflow-only-context-injection.md section 3.
*/
export function emitterPrompt(ctx: PipelineContext, role: string, extra?: Record<string, unknown>): string {
    // Serialized, never interpolated, and delivered on quoted-heredoc stdin.
    const payload = JSON.stringify(Object.assign(
        { worktree: ctx.worktree, projectRoot: ctx.projectRoot, sourceBranch: ctx.sourceBranch, runId: ctx.runId },
        extra || {},
    ));
    // No backtick anywhere: a prompt is not a shell, and command substitution never expands here.
    return `Run this with Bash:
node ${ctx.emitter} ${ctx.task} ${role} <<'TTPAYLOAD'
${payload}
TTPAYLOAD
Follow the printed instructions.`;
}

/*
  An [S] box. A null result is the diagram's dotted "agent() errored" edge.
*/
export async function runAgent(
    ctx: PipelineContext,
    label: string,
    box: string,
    role: string,
    schema: unknown,
    extra?: Record<string, unknown>,
): Promise<unknown> {
    step(ctx, `<-- AGENT --> ${label}`);
    const visit = ctx.agentVisits.get(box) ?? 0;
    ctx.agentVisits.set(box, visit + 1);
    if (isFake(ctx)) {
        const errors = (ctx.fake as Record<string, Record<string, boolean[]>>).agentErrors ?? {};
        const errored = attempt(errors[box] ?? [false], visit);
        if (errored) step(ctx, ctx.L("AGENT_ERRORED"));
        return errored ? null : {};
    }
    const result = await ctx.agent(emitterPrompt(ctx, role, extra), { label: `${role}:${ctx.task}`, schema });
    if (result === null) step(ctx, ctx.L("AGENT_ERRORED"));
    return result;
}

/*
  Paragraph 3: an operational script failure ends the run as run-failed, from any green box.
*/

/*
  Paragraph 4: a lost mutating result is reconciled first, never blindly retried.
*/

// ---------------------------------------------------------------------------
// Return shapes for the 10 agent boxes
// ---------------------------------------------------------------------------

export const PLAN_RESULT = {
    type: "object",
    required: ["outcome"],
    properties: {
        outcome: { type: "string", enum: ["PLAN", "CLARIFY", "ERROR"] },
        clarifyRequest: { type: "string" },
    },
};

export const REVIEW_PLAN_RESULT = {
    type: "object",
    required: ["verdict"],
    properties: {
        verdict: { type: "string", enum: ["ACCEPT", "AMEND_THEN_ACCEPT", "AMEND", "SCRAP", "ERROR"] },
        notes: { type: "string" },
    },
};

export const IMPLEMENT_RESULT = {
    type: "object",
    required: ["implemented"],
    properties: { implemented: { type: "boolean" }, notes: { type: "string" } },
};

export const REVIEW_TESTS_RESULT = {
    type: "object",
    required: ["flagged"],
    properties: { flagged: { type: "boolean" }, notes: { type: "string" } },
};

export const FIX_CONFLICTS_RESULT = {
    type: "object",
    required: ["resolved"],
    properties: {
        resolved: { type: "boolean" },
        unresolvedPaths: { type: "array", items: { type: "string" } },
    },
};

export const REBASE_WORKTREE_RESULT = {
    type: "object",
    required: ["conflicted"],
    properties: { conflicted: { type: "boolean" } },
};

export const CONTINUE_REBASE_RESULT = {
    type: "object",
    required: ["finished"],
    properties: { finished: { type: "boolean" } },
};

export const RUN_TASK_TESTS_RESULT = {
    type: "object",
    required: ["passed"],
    properties: { passed: { type: "boolean" } },
};

export const RUN_FULL_SUITE_RESULT = {
    type: "object",
    required: ["passed"],
    properties: { passed: { type: "boolean" } },
};

export const CHECK_FENCE_RESULT = {
    type: "object",
    required: ["inside"],
    properties: {
        inside: { type: "boolean" },
        violations: { type: "array", items: { type: "string" } },
    },
};

export const MERGE_WORKTREES_RESULT = {
    type: "object",
    required: ["state"],
    properties: { state: { type: "string", enum: ["ALL LANDED", "SOME LANDED", "NONE LANDED"] } },
};

export const LOCK_SOURCE_REPO_RESULT = {
    type: "object",
    required: ["acquired"],
    properties: { acquired: { type: "boolean" }, heldByOwner: { type: ["string", "null"] } },
};

export const FINISH_RUN_RESULT = {
    type: "object",
    required: ["exitType", "workLanded"],
    properties: {
        exitType: { type: "string" },
        workLanded: { type: "boolean" },
        publicationState: { type: ["string", "null"] },
        leaseReleased: { type: "boolean" },
        lockReleased: { type: "boolean" },
        closureNote: { type: ["string", "null"] },
    },
};

export const FIX_SUITE_RESULT = {
    type: "object",
    required: ["fixed"],
    properties: { fixed: { type: "boolean" }, notes: { type: "string" } },
};

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------

/*
  Every exit below the preamble takes the failures tail, because the task is already active.
*/
export function toFailures(exitType: string, exitNote: string, workLanded?: boolean): PipelineOutcome {
    return { done: true, exitType, exitNote, workLanded: workLanded === true };
}

/*
  Performs a whole exit tail in one agent, because the sandbox cannot run its scripts.
*/
export async function runExitTail(ctx: PipelineContext, exitType: string, exitNote: string): Promise<unknown> {
    if (isFake(ctx)) return null;
    const prompt = emitterPrompt(ctx, "finish-run", { exitType, exitNote });
    const receipt = await ctx.agent(prompt, { label: `finish-run:${ctx.task}`, schema: FINISH_RUN_RESULT });
    if (receipt === null) throw new Error("tackle-tasks workflow: the exit tail returned nothing usable");
    return receipt;
}

/*
  plans/diagram/pipeline-failuresExit.mmd. Every box is [C].
*/
export async function failuresExit(
    ctx: PipelineContext,
    exitType: string,
    exitNote: string,
    workLanded?: boolean,
): Promise<{ task: number; exitType: string; exitNote: string; trace: string[] }> {
    banner(ctx, "failures exit");
    const receipt = await runExitTail(ctx, exitType, exitNote) as { exitType: string; workLanded: boolean } | null;
    // Real mode reads git's answer; fake mode keeps the caller's, so a fixture path is unchanged.
    const landed = receipt === null ? workLanded === true : receipt.workLanded;
    const finalExitType = receipt === null ? exitType : receipt.exitType;
    // Paragraph 85: ask git what landed before writing anything, never the incoming exit type.
    step(ctx, ctx.L("READ_PUBLICATION_STATE"));
    step(ctx, ctx.L("DID_ANY_WORK_LAND"), yesNo(landed));
    // Paragraph 86: landed work discards the incoming exit type, run-failed included.
    if (landed) step(ctx, ctx.L("WRITE_PUBLICATION_OUTCOME"));
    else step(ctx, ctx.L("WRITE_EXIT_TYPE_AND_NOTE"), finalExitType.toUpperCase());
    step(ctx, ctx.L("RECORD_MODIFIED_FILES_FAILURE"));
    // Paragraphs 89 and 90: the lease and the source lock are independent ownership checks.
    step(ctx, ctx.L("DOES_RUN_HOLD_LEASE"), "YES");
    // Paragraph 93: the worktree is never removed here, only its lease released.
    step(ctx, ctx.L("RELEASE_WORKTREE_LEASE"));
    step(ctx, ctx.L("DOES_RUN_HOLD_SOURCE_LOCK"), yesNo(ctx.sourceLockHeld));
    if (ctx.sourceLockHeld) step(ctx, ctx.L("RELEASE_SOURCE_LOCK"));
    // Paragraph 91: mark inactive last, after every release and every write.
    step(ctx, ctx.L("MARK_TASK_INACTIVE_FAILURE"));
    step(ctx, ctx.L("REPORT_EXIT_TYPE_AND_NOTE"), finalExitType.toUpperCase());
    step(ctx, ctx.L("STOP"));
    return { task: ctx.task, exitType: finalExitType, exitNote, trace: ctx.trace };
}

/*
  Paragraph 94: every mutating box on that tail is reconciled, not retried.
*/

/*
  plans/diagram/pipeline-mergeSucceededExit.mmd. Every box is [C].
*/
export async function mergeSucceededExit(
    ctx: PipelineContext,
): Promise<{ task: number; exitType: string; exitNote: string; trace: string[] }> {
    banner(ctx, "merge succeeded exit");
    await runExitTail(ctx, "completed", "");
    step(ctx, ctx.L("MERGE_RECEIPT_INPUT"));
    step(ctx, ctx.L("RECORD_MERGE_COMMIT_HASHES"));
    // Paragraph 79: completed is the point of no return, written before any release.
    step(ctx, ctx.L("WRITE_EXIT_TYPE_COMPLETED"));
    step(ctx, ctx.L("RECORD_MODIFIED_FILES_SUCCESS"));
    // Paragraph 81: the only box releasing both the source lock and the worktree lease.
    step(ctx, ctx.L("CLEAN_UP_WORKTREES"));
    step(ctx, ctx.L("BUILD_CLOSURE_NOTE"));
    step(ctx, ctx.L("MARK_TASK_INACTIVE_SUCCESS"));
    step(ctx, ctx.L("ARCHIVE_TASK"));
    step(ctx, ctx.L("REPORT_CLOSURE_NOTE"));
    step(ctx, ctx.L("STOP"));
    return { task: ctx.task, exitType: "completed", exitNote: "", trace: ctx.trace };
}

/*
  Paragraph 84: the merge's layer refs make a dead run safe, not this tail.
*/

// ---------------------------------------------------------------------------
// Plan — plans/diagram/pipeline-plan.mmd, paragraphs 23 to 29
// ---------------------------------------------------------------------------

export async function planPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "plan");
    ctx.phase("Plan");
    step(ctx, ctx.L("DOCS_INPUT"));

    // Paragraph 23 [S]: turn the tasks.json entry into a plan, reading the entry and docs only.
    const extra = ctx.planExtra;
    ctx.planExtra = {};
    const result = await runAgent(ctx, ctx.L("PLAN_THE_TASK"), "PLANNER", "plan", PLAN_RESULT, extra);

    // Paragraph 26: nothing usable back, and the task is active, so the failures exit runs.
    if (result === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

    const outcome = isFake(ctx)
        ? attempt((ctx.fake as Record<string, string[]>).plannerOutcome, ctx.plannerIndex)
        : (result as { outcome: string }).outcome;
    ctx.plannerIndex += 1;
    step(ctx, ctx.L("WHAT_DID_THE_PLANNER_RETURN"), outcome);

    if (outcome === "ERROR") return toFailures("agent-failed", AGENT_FAILED_NOTE);
    // Paragraph 25.
    if (outcome === "PLAN") return { next: "review-plan" };

    // Paragraph 27: CLARIFY is how a planner asks for what it was never given.
    const roundsDone = ctx.clarifyRounds >= MAX_ATTEMPTS;
    // Capped at 2 rounds: no user answers, so a third ask learns nothing new.
    step(ctx, ctx.L("ARE_2_CLARIFY_ROUNDS_DONE"), yesNo(roundsDone));

    // Paragraph 29.
    if (roundsDone) {
        return toFailures(
            "clarify-stuck",
            "the planner asked twice for something the docs cannot supply. worktree preserved.",
        );
    }

    ctx.clarifyRounds += 1;
    // Paragraph 28: the planner reads only the entry and the docs, so write it there.
    step(ctx, ctx.L("WRITE_CLARIFY_REQUEST"));
    ctx.planExtra.clarifyRequest = (result as { clarifyRequest?: string }).clarifyRequest ?? "";
    ctx.depth += 1;
    return { next: "document-generation" };
}

// ---------------------------------------------------------------------------
// Document generation — plans/diagram/pipeline-documentGeneration.mmd, paragraphs 20 to 22
// ---------------------------------------------------------------------------

export async function documentGenerationPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "document generation");
    step(ctx, ctx.L("WORKTREE_DOCS_MODE_INPUT"));
    // A clarify round always re-enters in UPDATE mode; AUTOGEN belongs to the preamble.
    step(ctx, ctx.L("WHAT_IS_DOCS_MODE"), "UPDATE");
    // Paragraph 21: UPDATE docs read the clarify request and grow to cover what it names.
    step(ctx, ctx.L("UPDATE_AUTO_GENERATED_DOCS"));
    ctx.planExtra.updateDocs = true;
    return { next: "plan" };
}

// ---------------------------------------------------------------------------
// Review plan — plans/diagram/pipeline-reviewPlan.mmd, paragraphs 30 to 35
// ---------------------------------------------------------------------------

export async function reviewPlanPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "review plan");
    step(ctx, ctx.L("DRAFT_PLAN_INPUT"));

    // Paragraph 30 [S].
    const result = await runAgent(ctx, ctx.L("CODEX_REVIEWS_PLAN"), "PLAN_REVIEWER", "review-plan", REVIEW_PLAN_RESULT);

    // Paragraph 31.
    if (result === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

    const verdict = isFake(ctx)
        ? attempt((ctx.fake as Record<string, string[]>).planVerdict, ctx.verdictIndex)
        : (result as { verdict: string }).verdict;
    ctx.verdictIndex += 1;
    step(ctx, ctx.L("WHAT_IS_REVIEW_VERDICT"), verdict);

    // The reviewer never read the plan, so this is an operational failure, not a plan defect.
    if (verdict === "ERROR") {
        return toFailures("run-failed", (result as { notes?: string }).notes ?? "the plan review could not run");
    }

    // Paragraph 32. AMEND_THEN_ACCEPT skips a second review: the fixes are already in the plan.
    if (verdict === "ACCEPT" || verdict === "AMEND_THEN_ACCEPT") return { next: "implement" };

    // Paragraph 33: the planner reads the entry, so codex's notes go into it before replanning.
    step(ctx, ctx.L("UPDATE_TASK_ENTRY"));
    ctx.planExtra.planReview = result;
    ctx.planReviews += 1;

    const reviewsDone = ctx.planReviews >= MAX_ATTEMPTS;
    step(ctx, ctx.L("ARE_2_REVIEWS_DONE"), yesNo(reviewsDone));

    // Paragraph 35: the task cannot be planned as written and needs dividing.
    if (reviewsDone) return toFailures("plan-scrapped", "codex did not accept the plan in two reviews");

    // Paragraph 34.
    ctx.depth += 1;
    return { next: "plan" };
}

// ---------------------------------------------------------------------------
// Implement — plans/diagram/pipeline-implement.mmd, paragraphs 36 to 40
// ---------------------------------------------------------------------------

export async function implementPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "implement");
    ctx.phase("Implement");
    step(ctx, ctx.L("ACCEPTED_PLAN_INPUT"));

    // Paragraph 36 [S]: implement the accepted plan, treating the worktree as project root.
    const extra = ctx.implementExtra;
    ctx.implementExtra = {};
    const result = await runAgent(ctx, ctx.L("IMPLEMENT_TASK"), "IMPLEMENTER", "implement", IMPLEMENT_RESULT, extra);

    // Paragraph 37.
    if (result === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

    // Paragraph 38: commit dirty work, commit nothing clean; later steps rebase and would lose it.
    step(ctx, ctx.L("COMMIT_IF_NEEDED"));
    return { next: "task-tests" };
}

/*
  Paragraph 39: the source lock is not taken here; the rebase preamble takes it later.
*/

/*
  Paragraph 40: both test pipelines re-enter implement, each amending the entry first.
*/

// ---------------------------------------------------------------------------
// Task tests — plans/diagram/pipeline-taskTests.mmd, paragraphs 41 to 44
// ---------------------------------------------------------------------------

export async function taskTestsPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "task tests");
    step(ctx, ctx.L("COMMITTED_WORK_INPUT"));

    // Paragraph 41 [S]: the sandbox cannot run a test file, so an agent invokes the run-task-tests skill.
    const testRun = await runAgent(ctx, ctx.L("RUN_TASK_TESTS"), "TEST_RUNNER", "run-task-tests", RUN_TASK_TESTS_RESULT);
    if (testRun === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

    const testsPass = isFake(ctx)
        ? attempt((ctx.fake as Record<string, boolean[]>).taskTestsPass, ctx.testsIndex)
        : (testRun as { passed: boolean }).passed;
    ctx.testsIndex += 1;
    step(ctx, ctx.L("DO_TASK_TESTS_PASS"), yesNo(testsPass));
    if (testsPass) return { next: "review-tests" };

    // Paragraph 42: ask the counter BEFORE amending, or the first failure spends it.
    const fixesDone = ctx.testFixes >= MAX_ATTEMPTS;
    step(ctx, ctx.L("ARE_2_TEST_FIXES_DONE"), yesNo(fixesDone));

    // Paragraph 44.
    if (fixesDone) return toFailures("tests-red", "task tests still failing after 2 fix attempts");

    // Paragraph 43: a repair is never tested until committed, so re-enter implement.
    step(ctx, ctx.L("AMEND_ENTRY_WITH_FAILING_TESTS"));
    ctx.implementExtra.amendFailingTests = true;
    ctx.testFixes += 1;
    ctx.depth += 1;
    return { next: "implement" };
}

// ---------------------------------------------------------------------------
// Review task tests — plans/diagram/pipeline-reviewTests.mmd, paragraphs 45 to 50
// ---------------------------------------------------------------------------

export async function reviewTestsPipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "review task tests");
    step(ctx, ctx.L("GREEN_IMPLEMENTATION_INPUT"));

    // Paragraph 45 [S]: review the tests, not the codebase.
    const result = await runAgent(ctx, ctx.L("CODEX_REVIEWS_TESTS"), "TEST_REVIEWER", "review-tests", REVIEW_TESTS_RESULT);

    // Paragraph 47.
    if (result === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

    const flagged = isFake(ctx)
        ? attempt((ctx.fake as Record<string, boolean[]>).testsFlagged, ctx.flaggedIndex)
        : (result as { flagged: boolean }).flagged;
    ctx.flaggedIndex += 1;
    step(ctx, ctx.L("ARE_TESTS_FLAGGED"), yesNo(flagged));

    // Paragraph 48.
    if (!flagged) return { next: "rebase-preamble" };

    const reviewsDone = ctx.testReviews >= MAX_ATTEMPTS;
    step(ctx, ctx.L("ARE_2_TEST_REVIEWS_DONE"), yesNo(reviewsDone));

    // Paragraph 50.
    if (reviewsDone) return toFailures("tests-flagged", "task tests failed codex review");

    // Paragraph 49: write codex's notes and fixes into the entry, then reimplement.
    step(ctx, ctx.L("AMEND_ENTRY_WITH_CODEX_NOTES"));
    ctx.implementExtra.testReview = result;
    ctx.testReviews += 1;
    ctx.depth += 1;
    return { next: "implement" };
}

/*
  Paragraph 46: reviewTestsPrompt passes three of the seven inputs the diagram names.
*/

/*
  The diff and pre-existing tests are derived here, from the merge-base with the target.
*/

// ---------------------------------------------------------------------------
// Rebase preamble — plans/diagram/pipeline-rebasePreamble.mmd, paragraphs 51 to 55
// ---------------------------------------------------------------------------

export async function rebasePreamblePipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "rebase preamble");
    ctx.phase("Rebase and merge");
    step(ctx, ctx.L("FINISHED_IMPLEMENTATION_INPUT"));

    // Paragraph 51: the lock owner is runId:taskNumber, never runId alone.
    step(ctx, ctx.L("LOCK_SOURCE_REPO"));
    const lockReceipt = isFake(ctx) ? null : await ctx.agent(emitterPrompt(ctx, "lock-source-repo"), {
        label: `lock-source-repo:${ctx.task}`,
        schema: LOCK_SOURCE_REPO_RESULT,
    });
    if (!isFake(ctx) && lockReceipt === null) return toFailures("run-failed", "the source repo lock box returned nothing usable");
    const acquired = isFake(ctx)
        ? attempt((ctx.fake as Record<string, boolean[]>).lockAcquired, ctx.lockIndex)
        : (lockReceipt as { acquired: boolean }).acquired;
    ctx.lockIndex += 1;
    step(ctx, ctx.L("WAS_LOCK_ACQUIRED"), yesNo(acquired));

    // Paragraphs 52 and 53: the 5s poll and its 15-minute cap live inside the script.
    if (!acquired) {
        step(ctx, ctx.L("HAVE_15_MINUTES_PASSED"), "YES");
        return toFailures("run-failed", "the source repo lock did not come free within 15 minutes");
    }

    ctx.sourceLockHeld = true;
    return { next: "rebase" };
}

/*
  Paragraph 54: the lock file sits under <projectRoot>/.git and is cleared by hand.
*/

/*
  Paragraph 55: every rebase, suite and merge box refreshes the lock heartbeat on entry.
*/

// ---------------------------------------------------------------------------
// Rebase — plans/diagram/pipeline-rebase.mmd, paragraphs 56 to 61
// ---------------------------------------------------------------------------

export async function rebasePipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "rebase");
    step(ctx, ctx.L("SOURCE_REPO_LOCKED_INPUT"));

    for (;;) {
        // Paragraphs 56 and 57 [S]: the sandbox cannot run a rebase, so an agent invokes the rebase-worktree skill.
        const rebaseRun = await runAgent(ctx, ctx.L("REBASE_ONTO_TARGET_BRANCH"), "REBASER", "rebase-worktree", REBASE_WORKTREE_RESULT);
        if (rebaseRun === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

        const conflicted = isFake(ctx)
            ? attempt((ctx.fake as Record<string, boolean[]>).rebaseConflicts, ctx.conflictsIndex)
            : (rebaseRun as { conflicted: boolean }).conflicted;
        ctx.conflictsIndex += 1;
        step(ctx, ctx.L("DID_REBASE_REPORT_CONFLICTS"), yesNo(conflicted));
        if (!conflicted) return { next: "suite" };

        const fixesDone = ctx.conflictFixes >= MAX_ATTEMPTS;
        step(ctx, ctx.L("ARE_2_CONFLICT_FIXES_DONE"), yesNo(fixesDone));

        // Paragraph 61.
        if (fixesDone) {
            return toFailures("rebase-stuck", "the rebase did not advance after 2 conflict fixes");
        }

        // Paragraph 58 [S]: leave the markers, pass the stopped layer and its files.
        const result = await runAgent(ctx, ctx.L("FIX_CONFLICTS"), "CONFLICT_FIXER", "fix-conflicts", FIX_CONFLICTS_RESULT, {
            checkoutPath: ctx.worktree,
            conflictedFilePaths: [],
        });

        // Paragraph 59.
        if (result === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

        ctx.conflictFixes += 1;

        // Paragraph 60: always fix, then commit, then continue — never fix then continue.
        step(ctx, ctx.L("COMMIT_IF_NEEDED"));
        const continueRun = await runAgent(ctx, ctx.L("CONTINUE_REBASE"), "REBASE_ADVANCER", "continue-rebase", CONTINUE_REBASE_RESULT);
        if (continueRun === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

        const finished = isFake(ctx)
            ? attempt((ctx.fake as Record<string, boolean[]>).rebaseFinished, ctx.finishedIndex)
            : (continueRun as { finished: boolean }).finished;
        ctx.finishedIndex += 1;
        step(ctx, ctx.L("IS_REBASE_FINISHED"), yesNo(finished));
        if (finished) return { next: "suite" };
        // A rebase can stop more than once, so an unfinished rebase turns this loop again.
        ctx.depth += 1;
    }
}

// ---------------------------------------------------------------------------
// Full suite — plans/diagram/pipeline-suite.mmd, paragraphs 62 to 69
// ---------------------------------------------------------------------------

export async function suitePipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "full suite");
    step(ctx, ctx.L("REBASED_WORKTREE_INPUT"));

    for (;;) {
        // Paragraph 62 [S]: the sandbox cannot run a suite, so an agent invokes the run-full-suite skill.
        const suiteRun = await runAgent(ctx, ctx.L("RUN_FULL_SUITE"), "SUITE_RUNNER", "run-full-suite", RUN_FULL_SUITE_RESULT);
        if (suiteRun === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

        const passes = isFake(ctx)
            ? attempt((ctx.fake as Record<string, boolean[]>).suitePasses, ctx.suiteIndex)
            : (suiteRun as { passed: boolean }).passed;
        ctx.suiteIndex += 1;
        step(ctx, ctx.L("DO_ALL_TESTS_PASS"), yesNo(passes));
        if (passes) break;

        const fixesDone = ctx.suiteFixes >= MAX_ATTEMPTS;
        step(ctx, ctx.L("ARE_2_SUITE_FIXES_DONE"), yesNo(fixesDone));

        // Paragraph 66.
        if (fixesDone) {
            return toFailures(
                "suite-red",
                "full suite still red after 2 fix attempts. merge aborted. worktree preserved.",
            );
        }

        // Paragraph 63 [S]: pass the failing tests, and fix the codebase, not the tests.
        const result = await runAgent(
            ctx,
            ctx.L("FIX_THE_CODEBASE_FOR_SUITE"),
            "SUITE_FIXER",
            "fix-suite",
            FIX_SUITE_RESULT,
        );

        // Paragraph 65.
        if (result === null) return toFailures("agent-failed", AGENT_FAILED_NOTE);

        ctx.suiteFixes += 1;

        // Paragraph 64: commit the repair before rerunning, so it is fix, commit, run.
        step(ctx, ctx.L("COMMIT_IF_NEEDED"));
        ctx.depth += 1;
    }

    // Paragraph 67: the fence gate runs once, after the fix loop and before the merge.
    const fenceReceipt = isFake(ctx) ? null : await ctx.agent(emitterPrompt(ctx, "check-fence"), {
        label: `check-fence:${ctx.task}`,
        schema: CHECK_FENCE_RESULT,
    });
    if (!isFake(ctx) && fenceReceipt === null) return toFailures("run-failed", "the fence check box returned nothing usable");
    const fenceHeld = isFake(ctx)
        ? (ctx.fake as Record<string, boolean>).fenceHeld
        : (fenceReceipt as { inside: boolean }).inside;
    // Paragraph 68: it re-derives the diff and never accepts a fence from a caller.
    step(ctx, ctx.L("DID_CHANGES_STAY_INSIDE_FENCE"), yesNo(fenceHeld));
    if (!fenceHeld) {
        return toFailures(
            "fence-violation",
            "a repair edited files the task does not own. nothing merged. worktree preserved.",
        );
    }
    return { next: "merge" };
}

/*
  Paragraph 69 is a known ceiling: one suite run can outlast the 15-minute lock.
*/

// ---------------------------------------------------------------------------
// Merge — plans/diagram/pipeline-merge.mmd, paragraphs 70 to 78
// ---------------------------------------------------------------------------

export async function mergePipeline(ctx: PipelineContext): Promise<PipelineOutcome> {
    banner(ctx, "merge");
    step(ctx, ctx.L("GREEN_WORKTREE_INPUT"));

    const mergeReceipt = isFake(ctx) ? null : await ctx.agent(emitterPrompt(ctx, "merge-worktrees"), {
        label: `merge-worktrees:${ctx.task}`,
        schema: MERGE_WORKTREES_RESULT,
    });
    if (!isFake(ctx) && mergeReceipt === null) return toFailures("run-failed", "the merge box returned nothing usable");

    // Paragraphs 70 and 71: no fast-forward, and each layer writes its merge ref as it lands.
    step(ctx, ctx.L("MERGE_WORKTREES"));

    // Paragraph 72: a read-only reconciliation over those refs, never a returned boolean.
    step(ctx, ctx.L("READ_PUBLICATION_STATE"));
    const state = isFake(ctx)
        ? attempt((ctx.fake as Record<string, string[]>).publicationState, ctx.publicationIndex)
        : (mergeReceipt as { state: string }).state;
    ctx.publicationIndex += 1;
    // Paragraph 73: merged, no-op and root-merged-but-not-closed are LANDED; conflicted is not.
    step(ctx, ctx.L("WHAT_IS_PUBLICATION_STATE"), state as string);

    // Paragraph 74.
    if (state === "ALL LANDED") return { next: "merge-succeeded" };

    // Paragraph 77: never retry a partial publication; it would re-land around public work.
    if (state === "SOME LANDED") {
        return toFailures(
            "partially-published",
            "some layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.",
            true,
        );
    }

    const attemptsDone = ctx.mergeAttempts >= MAX_ATTEMPTS;
    step(ctx, ctx.L("ARE_2_MERGE_ATTEMPTS_DONE"), yesNo(attemptsDone));

    // Paragraph 76.
    if (attemptsDone) return toFailures("merge-failed", "nothing landed after 2 attempts. worktree preserved.");

    ctx.mergeAttempts += 1;
    ctx.depth += 1;
    // Paragraph 75: re-enter rebase, not the rebase preamble; the target branch tip moved.
    return { next: "rebase" };
}

/*
  Paragraph 78: a no-op layer is a real completion, so an all-no-op task lands ALL LANDED.
*/

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/*
  The diagrams have back-edges, so the pipelines are a state machine, not a chain.
*/
export const PIPELINES: Record<string, (ctx: PipelineContext) => Promise<PipelineOutcome>> = {
    "plan": planPipeline,
    "document-generation": documentGenerationPipeline,
    "review-plan": reviewPlanPipeline,
    "implement": implementPipeline,
    "task-tests": taskTestsPipeline,
    "review-tests": reviewTestsPipeline,
    "rebase-preamble": rebasePreamblePipeline,
    "rebase": rebasePipeline,
    "suite": suitePipeline,
    "merge": mergePipeline,
};

export async function runTaskPipeline(ctx: PipelineContext, start?: string): Promise<string[]> {
    ctx.trace.push(`Run start: Task Num [${ctx.task}]`);
    ctx.log(ctx.trace[0] as string);

    let current = start ?? "plan";
    for (;;) {
        const result = await (PIPELINES[current] as (ctx: PipelineContext) => Promise<PipelineOutcome>)(ctx);

        if (result.done) {
            ctx.phase("Exit");
            await failuresExit(ctx, result.exitType, result.exitNote, result.workLanded);
            return ctx.trace;
        }
        if (result.next === "merge-succeeded") {
            ctx.phase("Exit");
            await mergeSucceededExit(ctx);
            return ctx.trace;
        }
        current = result.next;
    }
}
