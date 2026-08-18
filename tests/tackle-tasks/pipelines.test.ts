// One diagram at a time: give a pipeline its inputs, check which endpoint of that diagram it leaves by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { L } from "../../scripts/tracePipeline.ts";
import {
    createPipelineContext,
    documentGenerationPipeline,
    implementPipeline,
    mergePipeline,
    planPipeline,
    rebasePipeline,
    rebasePreamblePipeline,
    reviewPlanPipeline,
    reviewTestsPipeline,
    suitePipeline,
    taskTestsPipeline,
    type PipelineContext,
    type PipelineOutcome,
} from "../../scripts/tackle-tasks/pipelines.ts";

const TASK = 169;

// Only the fields the pipeline under test reads need a value, so each test names its own.
const contextFor = (fake: Record<string, unknown> | null): PipelineContext =>
    createPipelineContext({
        task: TASK,
        emitter: "/abs/repo/scripts/tackle-tasks/AgentPromptEmitter.ts",
        worktree: "/abs/repo/.worktrees/task-169",
        projectRoot: "/abs/repo",
        sourceBranch: "master",
        runId: "run-abc",
        fake,
        L,
        agent: async () => {
            throw new Error("real agent() must never be called in fake mode");
        },
        log: () => {},
        phase: () => {},
    });

// A pipeline leaves its diagram either by naming the next pipeline, or by an exit type.
const endpointOf = (outcome: PipelineOutcome): string =>
    outcome.done ? `exit:${outcome.exitType}` : `next:${outcome.next}`;

type Case = {
    name: string;
    pipeline: (ctx: PipelineContext) => Promise<PipelineOutcome>;
    fake: Record<string, unknown>;
    endpoint: string;
    // Pre-set counters put the pipeline at the round the endpoint needs, without running the others.
    counters?: Partial<PipelineContext>;
};

// ---------------------------------------------------------------------------
// pipeline-plan.mmd — every endpoint the diagram draws
// ---------------------------------------------------------------------------

const PLAN_CASES: Case[] = [
    { name: "PLAN goes on to review the plan", pipeline: planPipeline, fake: { plannerOutcome: ["PLAN"] }, endpoint: "next:review-plan" },
    { name: "CLARIFY goes on to regenerate the docs", pipeline: planPipeline, fake: { plannerOutcome: ["CLARIFY"] }, endpoint: "next:document-generation" },
    { name: "CLARIFY twice over leaves clarify-stuck", pipeline: planPipeline, fake: { plannerOutcome: ["CLARIFY"] }, endpoint: "exit:clarify-stuck", counters: { clarifyRounds: 2 } },
    { name: "ERROR leaves agent-failed", pipeline: planPipeline, fake: { plannerOutcome: ["ERROR"] }, endpoint: "exit:agent-failed" },
    { name: "a lost planner result leaves agent-failed", pipeline: planPipeline, fake: { plannerOutcome: ["PLAN"], agentErrors: { PLANNER: [true] } }, endpoint: "exit:agent-failed" },
];

// ---------------------------------------------------------------------------
// pipeline-reviewPlan.mmd — the five verdicts, plus the dotted edge
// ---------------------------------------------------------------------------

const REVIEW_PLAN_CASES: Case[] = [
    { name: "ACCEPT goes on to implement", pipeline: reviewPlanPipeline, fake: { planVerdict: ["ACCEPT"] }, endpoint: "next:implement" },
    { name: "AMEND_THEN_ACCEPT goes on to implement", pipeline: reviewPlanPipeline, fake: { planVerdict: ["AMEND_THEN_ACCEPT"] }, endpoint: "next:implement" },
    { name: "AMEND sends the plan back to the planner", pipeline: reviewPlanPipeline, fake: { planVerdict: ["AMEND"] }, endpoint: "next:plan" },
    { name: "SCRAP sends the plan back to the planner", pipeline: reviewPlanPipeline, fake: { planVerdict: ["SCRAP"] }, endpoint: "next:plan" },
    { name: "a second AMEND leaves plan-scrapped", pipeline: reviewPlanPipeline, fake: { planVerdict: ["AMEND"] }, endpoint: "exit:plan-scrapped", counters: { planReviews: 1 } },
    { name: "ERROR leaves run-failed", pipeline: reviewPlanPipeline, fake: { planVerdict: ["ERROR"] }, endpoint: "exit:run-failed" },
    { name: "a lost reviewer result leaves agent-failed", pipeline: reviewPlanPipeline, fake: { planVerdict: ["ACCEPT"], agentErrors: { PLAN_REVIEWER: [true] } }, endpoint: "exit:agent-failed" },
];

// ---------------------------------------------------------------------------
// pipeline-implement.mmd and pipeline-documentGeneration.mmd — one endpoint each
// ---------------------------------------------------------------------------

const STRAIGHT_THROUGH_CASES: Case[] = [
    { name: "implement goes on to the task tests", pipeline: implementPipeline, fake: {}, endpoint: "next:task-tests" },
    { name: "a lost implementer result leaves agent-failed", pipeline: implementPipeline, fake: { agentErrors: { IMPLEMENTER: [true] } }, endpoint: "exit:agent-failed" },
    { name: "document generation goes back to the planner", pipeline: documentGenerationPipeline, fake: {}, endpoint: "next:plan" },
];

// ---------------------------------------------------------------------------
// pipeline-taskTests.mmd and pipeline-reviewTests.mmd
// ---------------------------------------------------------------------------

const TEST_CASES: Case[] = [
    { name: "passing task tests go on to the test review", pipeline: taskTestsPipeline, fake: { taskTestsPass: [true] }, endpoint: "next:review-tests" },
    { name: "failing task tests go back to implement", pipeline: taskTestsPipeline, fake: { taskTestsPass: [false] }, endpoint: "next:implement" },
    { name: "failing task tests out of fixes leave tests-red", pipeline: taskTestsPipeline, fake: { taskTestsPass: [false] }, endpoint: "exit:tests-red", counters: { testFixes: 2 } },
    { name: "a lost test-runner result leaves agent-failed", pipeline: taskTestsPipeline, fake: { taskTestsPass: [true], agentErrors: { TEST_RUNNER: [true] } }, endpoint: "exit:agent-failed" },
    { name: "unflagged tests go on to the rebase preamble", pipeline: reviewTestsPipeline, fake: { testsFlagged: [false] }, endpoint: "next:rebase-preamble" },
    { name: "flagged tests go back to implement", pipeline: reviewTestsPipeline, fake: { testsFlagged: [true] }, endpoint: "next:implement" },
    { name: "flagged tests out of reviews leave tests-flagged", pipeline: reviewTestsPipeline, fake: { testsFlagged: [true] }, endpoint: "exit:tests-flagged", counters: { testReviews: 2 } },
    { name: "a lost test-reviewer result leaves agent-failed", pipeline: reviewTestsPipeline, fake: { testsFlagged: [false], agentErrors: { TEST_REVIEWER: [true] } }, endpoint: "exit:agent-failed" },
];

// ---------------------------------------------------------------------------
// pipeline-rebasePreamble.mmd, pipeline-rebase.mmd, pipeline-suite.mmd, pipeline-merge.mmd
// ---------------------------------------------------------------------------

const TAIL_CASES: Case[] = [
    { name: "an acquired lock goes on to the rebase", pipeline: rebasePreamblePipeline, fake: { lockAcquired: [true] }, endpoint: "next:rebase" },
    { name: "a lock that never came free leaves run-failed", pipeline: rebasePreamblePipeline, fake: { lockAcquired: [false] }, endpoint: "exit:run-failed" },

    { name: "a clean rebase goes on to the suite", pipeline: rebasePipeline, fake: { rebaseConflicts: [false] }, endpoint: "next:suite" },
    { name: "a conflict fixed and finished goes on to the suite", pipeline: rebasePipeline, fake: { rebaseConflicts: [true], rebaseFinished: [true] }, endpoint: "next:suite" },
    { name: "a rebase out of conflict fixes leaves rebase-stuck", pipeline: rebasePipeline, fake: { rebaseConflicts: [true], rebaseFinished: [true] }, endpoint: "exit:rebase-stuck", counters: { conflictFixes: 2 } },
    { name: "a lost rebaser result leaves agent-failed", pipeline: rebasePipeline, fake: { rebaseConflicts: [false], agentErrors: { REBASER: [true] } }, endpoint: "exit:agent-failed" },
    { name: "a lost conflict-fixer result leaves agent-failed", pipeline: rebasePipeline, fake: { rebaseConflicts: [true], rebaseFinished: [true], agentErrors: { CONFLICT_FIXER: [true] } }, endpoint: "exit:agent-failed" },
    { name: "a lost rebase-advancer result leaves agent-failed", pipeline: rebasePipeline, fake: { rebaseConflicts: [true], rebaseFinished: [true], agentErrors: { REBASE_ADVANCER: [true] } }, endpoint: "exit:agent-failed" },

    { name: "a green suite inside the fence goes on to the merge", pipeline: suitePipeline, fake: { suitePasses: [true], fenceHeld: true }, endpoint: "next:merge" },
    { name: "a green suite outside the fence leaves fence-violation", pipeline: suitePipeline, fake: { suitePasses: [true], fenceHeld: false }, endpoint: "exit:fence-violation" },
    { name: "a suite fixed then green goes on to the merge", pipeline: suitePipeline, fake: { suitePasses: [false, true], fenceHeld: true }, endpoint: "next:merge" },
    { name: "a suite out of fixes leaves suite-red", pipeline: suitePipeline, fake: { suitePasses: [false], fenceHeld: true }, endpoint: "exit:suite-red", counters: { suiteFixes: 2 } },
    { name: "a lost suite-runner result leaves agent-failed", pipeline: suitePipeline, fake: { suitePasses: [true], fenceHeld: true, agentErrors: { SUITE_RUNNER: [true] } }, endpoint: "exit:agent-failed" },
    { name: "a lost suite-fixer result leaves agent-failed", pipeline: suitePipeline, fake: { suitePasses: [false], fenceHeld: true, agentErrors: { SUITE_FIXER: [true] } }, endpoint: "exit:agent-failed" },

    { name: "ALL LANDED goes on to the merge succeeded exit", pipeline: mergePipeline, fake: { publicationState: ["ALL LANDED"] }, endpoint: "next:merge-succeeded" },
    { name: "NONE LANDED goes back to the rebase", pipeline: mergePipeline, fake: { publicationState: ["NONE LANDED"] }, endpoint: "next:rebase" },
    { name: "NONE LANDED out of attempts leaves merge-failed", pipeline: mergePipeline, fake: { publicationState: ["NONE LANDED"] }, endpoint: "exit:merge-failed", counters: { mergeAttempts: 2 } },
    { name: "SOME LANDED leaves partially-published", pipeline: mergePipeline, fake: { publicationState: ["SOME LANDED"] }, endpoint: "exit:partially-published" },
];

for (const group of [PLAN_CASES, REVIEW_PLAN_CASES, STRAIGHT_THROUGH_CASES, TEST_CASES, TAIL_CASES]) {
    for (const { name, pipeline, fake, endpoint, counters } of group) {
        test(`test_pipeline_${name.replace(/[^a-zA-Z0-9]+/g, "_")}`, async () => {
            // Setup: one diagram, its own inputs, and nothing else in the pipeline runs.
            const ctx = Object.assign(contextFor(fake), counters ?? {});

            // Test action: walk that diagram once.
            const outcome = await pipeline(ctx);

            // Verification: it left by the endpoint the diagram draws for those inputs.
            assert.equal(endpointOf(outcome), endpoint);
        });
    }
}

test("test_pipeline_partiallyPublishedIsTheOnlyExitThatCarriesLandedWork", async () => {
    // Setup: the failures tail reads workLanded to decide whether to keep the incoming exit type.
    const partial = await mergePipeline(contextFor({ publicationState: ["SOME LANDED"] }));
    const nothing = await mergePipeline(Object.assign(
        contextFor({ publicationState: ["NONE LANDED"] }),
        { mergeAttempts: 2 },
    ));

    // Verification: only a partial publication has work on a target branch already.
    assert.equal(partial.done && partial.workLanded, true);
    assert.equal(nothing.done && nothing.workLanded, false);
});

test("test_pipeline_holdsTheSourceLockOnlyOnceTheRebasePreambleAcquiredIt", async () => {
    // Setup: the exit tail releases the lock only when this flag says the run took one.
    const acquired = contextFor({ lockAcquired: [true] });
    const refused = contextFor({ lockAcquired: [false] });

    // Test action: walk the rebase preamble both ways.
    await rebasePreamblePipeline(acquired);
    await rebasePreamblePipeline(refused);

    // Verification: only the acquiring run carries the lock into the rest of the pipeline.
    assert.equal(acquired.sourceLockHeld, true);
    assert.equal(refused.sourceLockHeld, false);
});
