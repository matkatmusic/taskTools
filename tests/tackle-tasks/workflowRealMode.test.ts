// Real mode: the lines FAKE mode never runs, driven by a stub agent that returns real result shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_PATH = join(REPO_ROOT, "skills/tackle-tasks/tackle-tasks.workflow.js");
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8").replace("export const meta", "const meta");

const TASK = 169;

const ARGS = {
    task: TASK,
    agentPromptEmitterPath: "/abs/repo/scripts/tackle-tasks/AgentPromptEmitter.ts",
    worktree: "/abs/repo/.worktrees/task-169",
    projectRoot: "/abs/repo",
    sourceBranch: "master",
    runId: "run-abc",
};

type AgentCall = { prompt: string; label: string; schema: { required: string[] } };
type Responder = (visit: number) => unknown;

// Every role answers the way a green run answers, so a test overrides only the role it is about.
const HAPPY_RESULTS: Record<string, unknown> = {
    "plan": { outcome: "PLAN" },
    "review-plan": { verdict: "ACCEPT" },
    "implement": { implemented: true },
    "run-task-tests": { passed: true },
    "review-tests": { flagged: false },
    "rebase-worktree": { conflicted: false },
    "fix-conflicts": { resolved: true, unresolvedPaths: [] },
    "continue-rebase": { finished: true },
    "run-full-suite": { passed: true },
    "fix-suite": { fixed: true },
};

// trace comes from log(), not the return value, so an unwired box still leaves its trace behind.
type RealRun = { trace: string[]; calls: AgentCall[]; error: Error | null };

// No args.fake, so isFake() is false and every result-reading line runs for real.
const runReal = async (overrides: Record<string, unknown | Responder> = {}): Promise<RealRun> => {
    const calls: AgentCall[] = [];
    const trace: string[] = [];
    const visits: Record<string, number> = {};

    const stubAgent = async (prompt: string, options: { label: string; schema: { required: string[] } }) => {
        const role = options.label.slice(0, options.label.lastIndexOf(":"));
        calls.push({ prompt, label: options.label, schema: options.schema });
        visits[role] = (visits[role] ?? 0) + 1;
        if (!(role in overrides)) return HAPPY_RESULTS[role];
        const responder = overrides[role];
        return typeof responder === "function" ? (responder as Responder)(visits[role]!) : responder;
    };

    const compiled = compileFunction(
        `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent", "phase"],
        { filename: WORKFLOW_PATH, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as (
        args: unknown,
        log: (...values: unknown[]) => void,
        agent: typeof stubAgent,
        phase: unknown,
    ) => Promise<string[]>;

    const log = (...values: unknown[]) => {
        trace.push(String(values[0]));
    };

    try {
        await compiled(ARGS, log, stubAgent, () => {});
        return { trace, calls, error: null };
    } catch (error) {
        return { trace, calls, error: error as Error };
    }
};

const callFor = (run: RealRun, role: string): AgentCall => {
    const call = run.calls.find((entry) => entry.label.startsWith(`${role}:`));
    assert.ok(call, `no agent call for role ${role}`);
    return call;
};

// Every prompt delivers its payload on one quoted heredoc, so nothing a shell sees can expand.
const payloadOf = (prompt: string): Record<string, unknown> => {
    const match = /<<'TTPAYLOAD'\n([\s\S]*?)\nTTPAYLOAD/.exec(prompt);
    assert.ok(match, "prompt carries no TTPAYLOAD heredoc");
    return JSON.parse(match[1]!) as Record<string, unknown>;
};

const countOf = (trace: string[], line: string): number =>
    trace.filter((entry) => entry.trim() === line).length;

const exitTypeOf = (trace: string[]): string => {
    const reported = trace.find((entry) => entry.trim().startsWith("report the run's exit type and note: "));
    return reported === undefined ? "completed" : reported.trim().split(": ")[1]!;
};

// --------------------------------------------------------------------------
// How far real mode reaches
// --------------------------------------------------------------------------

test("test_realMode_stopsAtTheFirstUnwiredDecisionBoxNamingIt", async () => {
    // Setup: every agent answers happily, so the run walks straight to the rebase preamble.
    const run = await runReal();

    // Verification: LOCK_SOURCE_REPO has no script yet, so the run throws instead of guessing.
    assert.match(run.error!.message, /\[C\] box not wired yet — LOCK_SOURCE_REPO/);
    assert.deepEqual(run.calls.map((call) => call.label), [
        `plan:${TASK}`,
        `review-plan:${TASK}`,
        `implement:${TASK}`,
        `run-task-tests:${TASK}`,
        `review-tests:${TASK}`,
    ]);
});

// --------------------------------------------------------------------------
// The prompt, label and schema handed to every reachable agent box
// --------------------------------------------------------------------------

const REACHABLE_BOXES: { role: string; required: string[] }[] = [
    { role: "plan", required: ["outcome"] },
    { role: "review-plan", required: ["verdict"] },
    { role: "implement", required: ["implemented"] },
    { role: "run-task-tests", required: ["passed"] },
    { role: "review-tests", required: ["flagged"] },
];

for (const { role, required } of REACHABLE_BOXES) {
    test(`test_realMode_handsThe_${role.replace(/-/g, "_")}_BoxItsEmitterCommandPayloadLabelAndSchema`, async () => {
        // Setup: one green run, which visits every reachable box once.
        const call = callFor(await runReal(), role);

        // Verification: the emitter is invoked by path, with the task number and this box's role.
        assert.ok(call.prompt.startsWith(`Run this with Bash:\nnode ${ARGS.agentPromptEmitterPath} ${TASK} ${role} <<'TTPAYLOAD'\n`));
        assert.ok(call.prompt.endsWith("\nTTPAYLOAD\nFollow the printed instructions."));
        // A backtick would let a shell substitute a command into the prompt, so there is never one.
        assert.doesNotMatch(call.prompt, /`/);
        assert.deepEqual(payloadOf(call.prompt), {
            worktree: ARGS.worktree,
            projectRoot: ARGS.projectRoot,
            sourceBranch: ARGS.sourceBranch,
            runId: ARGS.runId,
        });
        assert.equal(call.label, `${role}:${TASK}`);
        assert.deepEqual(call.schema.required, required);
    });
}

// --------------------------------------------------------------------------
// The four result fields FAKE mode reads from a fixture instead of the agent
// --------------------------------------------------------------------------

test("test_realMode_readsThePlannerOutcomeFromTheAgentResult", async () => {
    // Setup: the planner asks for clarification twice, then plans.
    const run = await runReal({ plan: (visit: number) => (visit < 3 ? { outcome: "CLARIFY" } : { outcome: "PLAN" }) });

    // Verification: result.outcome drove both clarify rounds, and the run went on to review the plan.
    assert.equal(countOf(run.trace, "what did the planner return?: CLARIFY"), 2);
    assert.equal(countOf(run.trace, "what did the planner return?: PLAN"), 1);
    assert.match(run.error!.message, /LOCK_SOURCE_REPO/);
});

test("test_realMode_exitsClarifyStuckOnTheThirdClarifyFromTheAgentResult", async () => {
    // Setup: the planner never stops asking, so the cap ends the run before the lock box.
    const run = await runReal({ plan: { outcome: "CLARIFY" } });

    // Verification: the run exits on its own trace, never reaching the unwired box.
    assert.equal(run.error, null);
    assert.equal(exitTypeOf(run.trace), "CLARIFY-STUCK");
    assert.equal(run.calls.filter((call) => call.label === `plan:${TASK}`).length, 3);
});

test("test_realMode_readsTheReviewVerdictFromTheAgentResult", async () => {
    // Setup: the reviewer could not read the plan at all.
    const run = await runReal({ "review-plan": { verdict: "ERROR", notes: "SENTINEL_REVIEW_STDERR" } });

    // Verification: result.verdict routed to run-failed, and no replan edge was taken.
    assert.equal(exitTypeOf(run.trace), "RUN-FAILED");
    assert.equal(countOf(run.trace, "update tasks.json entry"), 0);
});

test("test_realMode_sendsAmendThenAcceptStraightToImplement", async () => {
    // Setup: the fixes are already in the plan, so implement reads them without a replan.
    const run = await runReal({ "review-plan": { verdict: "AMEND_THEN_ACCEPT" } });

    // Verification: implement ran after exactly one review and one plan.
    assert.equal(run.calls.filter((call) => call.label === `plan:${TASK}`).length, 1);
    assert.ok(run.calls.some((call) => call.label === `implement:${TASK}`));
    assert.equal(countOf(run.trace, "update tasks.json entry"), 0);
});

test("test_realMode_readsTheTaskTestVerdictFromTheAgentResult", async () => {
    // Setup: the task tests never go green.
    const run = await runReal({ "run-task-tests": { passed: false } });

    // Verification: testRun.passed drove three runs and two repairs, then the red exit.
    assert.equal(exitTypeOf(run.trace), "TESTS-RED");
    assert.equal(run.calls.filter((call) => call.label === `run-task-tests:${TASK}`).length, 3);
    assert.equal(run.calls.filter((call) => call.label === `implement:${TASK}`).length, 3);
});

test("test_realMode_readsTheTestReviewFlagFromTheAgentResult", async () => {
    // Setup: codex flags the tests on the first two reviews, then accepts them.
    const run = await runReal({ "review-tests": (visit: number) => ({ flagged: visit < 3 }) });

    // Verification: result.flagged drove two amend rounds and then let the run reach the lock box.
    assert.equal(countOf(run.trace, "amend tasks.json entry with codex's notes and fixes"), 2);
    assert.match(run.error!.message, /LOCK_SOURCE_REPO/);
});

// --------------------------------------------------------------------------
// The dotted "agent() errored" edge, which FAKE mode fakes and real mode reads
// --------------------------------------------------------------------------

for (const { role } of REACHABLE_BOXES) {
    test(`test_realMode_treatsANullResultFrom_${role.replace(/-/g, "_")}_AsTheAgentErroredEdge`, async () => {
        // Setup: the harness loses that box's result, which reaches the workflow as null.
        const run = await runReal({ [role]: null });

        // Verification: the dotted edge is drawn, the box is never retried, and the run ends.
        assert.equal(run.error, null);
        assert.equal(countOf(run.trace, "agent() errored"), 1);
        assert.equal(exitTypeOf(run.trace), "AGENT-FAILED");
        assert.equal(run.calls.filter((call) => call.label === `${role}:${TASK}`).length, 1);
    });
}
