// Real mode: the lines FAKE mode never runs, driven by a stub agent that returns real result shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
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

// Every prompt delivers its payload on one quoted heredoc, so nothing a shell sees can expand.
const payloadOf = (prompt: string): Record<string, unknown> => {
    const match = /<<'TTPAYLOAD'\n([\s\S]*?)\nTTPAYLOAD/.exec(prompt);
    assert.ok(match, "prompt carries no TTPAYLOAD heredoc");
    return JSON.parse(match[1]!) as Record<string, unknown>;
};

type AgentCall = { prompt: string; label: string; schema: { required: string[] } };
type Responder = (visit: number) => unknown;

// A [C] box now runs behind one generic "run-step" label, so a test names the box, not the label.
const boxIdOf = (call: AgentCall): string | null => {
    const match = /^\/run-step "[^"]*" "[^"]*" "[^"]*" "[^"]*" "[^"]*" "([A-Z_]+)"/m.exec(call.prompt);
    return match === null ? null : match[1]!;
};

// The box id a run-step call carries, mapped back to the role a test overrides it by.
const RUN_STEP_ROLES: Record<string, string> = {
    RUN_TASK_TESTS: "run-task-tests",
    REBASE_ONTO_TARGET_BRANCH: "rebase-worktree",
    CONTINUE_REBASE: "continue-rebase",
    RUN_FULL_SUITE: "run-full-suite",
};

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
    "lock-source-repo": { acquired: true, heldByOwner: null },
    "check-fence": { inside: true, violations: [] },
    "merge-worktrees": { state: "ALL LANDED" },
};

// The exit tail writes the incoming exit type back when nothing landed, so the stub echoes it.
const finishRunResult = (prompt: string): unknown => ({
    exitType: payloadOf(prompt).exitType,
    workLanded: false,
    publicationState: "NONE LANDED",
    leaseReleased: true,
    lockReleased: true,
    closureNote: null,
});

const hookPath = join(REPO_ROOT, "scripts/runStepHook.ts");

// The retry counters the hook reads live in tasks.json, so real mode gets a real one on disk.
const rootWithNoAttempts = (): string => {
    const root = mkdtempSync(join(tmpdir(), "workflowRealMode-"));
    const record = {
        runId: ARGS.runId, startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
        exitType: null, exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null, attempts: {},
    };
    const run = { active: true, worktree: null, leaseRunId: null, history: [record] };
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify([{ taskNumber: TASK, title: "t", run }], null, 2)}\n`);
    writeFileSync(join(root, "completedTasks.json"), "[]\n");
    return root;
};

// trace comes from log(), not the return value, so an unwired box still leaves its trace behind.
type RealRun = { trace: string[]; calls: AgentCall[]; error: Error | null; projectRoot: string };

// No args.fake, so isFake() is false and every result-reading line runs for real.
const runReal = async (overrides: Record<string, unknown | Responder> = {}): Promise<RealRun> => {
    const calls: AgentCall[] = [];
    const trace: string[] = [];
    const visits: Record<string, number> = {};

    const projectRoot = rootWithNoAttempts();

    const stubAgent = async (prompt: string, options: { label: string; schema: { required: string[] } }) => {
        const role = options.label.slice(0, options.label.lastIndexOf(":"));
        calls.push({ prompt, label: options.label, schema: options.schema });
        // A cap decision reads tasks.json, so the real hook answers it.
        const decide = prompt.match(/^\/run-step .*--decide.*$/m);
        if (decide !== null) {
            const answered = spawnSync("node", [hookPath], {
                input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: decide[0] }),
                encoding: "utf8",
            });
            return JSON.parse(JSON.parse(answered.stdout).hookSpecificOutput.additionalContext);
        }
        if (role === "run-step") {
            const boxId = boxIdOf({ prompt, label: options.label, schema: options.schema });
            const receiptRole = boxId === null ? undefined : RUN_STEP_ROLES[boxId];
            if (receiptRole === undefined) return { ok: true };
            visits[receiptRole] = (visits[receiptRole] ?? 0) + 1;
            const value = receiptRole in overrides
                ? (typeof overrides[receiptRole] === "function"
                    ? (overrides[receiptRole] as Responder)(visits[receiptRole]!)
                    : overrides[receiptRole])
                : HAPPY_RESULTS[receiptRole];
            return value === null ? null : { ok: true, receipts: { [boxId as string]: value } };
        }
        visits[role] = (visits[role] ?? 0) + 1;
        if (!(role in overrides)) return role === "finish-run" ? finishRunResult(prompt) : HAPPY_RESULTS[role];
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
        await compiled({ ...ARGS, projectRoot }, log, stubAgent, () => {});
        return { trace, calls, error: null, projectRoot };
    } catch (error) {
        return { trace, calls, error: error as Error, projectRoot };
    }
};

const callFor = (run: RealRun, role: string): AgentCall => {
    const call = run.calls.find((entry) => entry.label.startsWith(`${role}:`));
    assert.ok(call, `no agent call for role ${role}`);
    return call;
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

test("test_realMode_walksEveryBoxToTheMergeSucceededExit", async () => {
    // Setup: every agent answers happily, so the run walks the whole diagram.
    const run = await runReal();

    // Verification: no agent box is unwired, and every one is dispatched once, in diagram order.
    assert.equal(run.error, null);
    assert.deepEqual(run.calls.map((call) => call.label).filter((label) => !label.startsWith("run-step:")), [
        `plan:${TASK}`,
        `review-plan:${TASK}`,
        `implement:${TASK}`,
        `review-tests:${TASK}`,
        `lock-source-repo:${TASK}`,
        `check-fence:${TASK}`,
        `merge-worktrees:${TASK}`,
        `finish-run:${TASK}`,
    ]);

    // Verification: the green boxes are dispatched now, rather than only traced.
    assert.ok(run.calls.some((call) => call.label === `run-step:${TASK}`));
    assert.equal(exitTypeOf(run.trace), "completed");
});

// --------------------------------------------------------------------------
// The prompt, label and schema handed to every reachable agent box
// --------------------------------------------------------------------------

const REACHABLE_BOXES: { role: string; required: string[] }[] = [
    { role: "plan", required: ["outcome"] },
    { role: "review-plan", required: ["verdict"] },
    { role: "implement", required: ["implemented"] },
    { role: "review-tests", required: ["flagged"] },
    { role: "lock-source-repo", required: ["acquired"] },
    { role: "check-fence", required: ["inside"] },
    { role: "merge-worktrees", required: ["state"] },
];

for (const { role, required } of REACHABLE_BOXES) {
    test(`test_realMode_handsThe_${role.replace(/-/g, "_")}_BoxItsEmitterCommandPayloadLabelAndSchema`, async () => {
        // Setup: one green run, which visits every reachable box once.
        const run = await runReal();
        const call = callFor(run, role);

        // Verification: the emitter is invoked by path, with the task number and this box's role.
        assert.ok(call.prompt.startsWith(`Run this with Bash:\nnode ${ARGS.agentPromptEmitterPath} ${TASK} ${role} <<'TTPAYLOAD'\n`));
        assert.ok(call.prompt.endsWith("\nTTPAYLOAD\nFollow the printed instructions."));
        // A backtick would let a shell substitute a command into the prompt, so there is never one.
        assert.doesNotMatch(call.prompt, /`/);
        assert.deepEqual(payloadOf(call.prompt), {
            worktree: ARGS.worktree,
            projectRoot: run.projectRoot,
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
    assert.equal(run.error, null);
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
    assert.equal(run.calls.filter((call) => boxIdOf(call) === "RUN_TASK_TESTS").length, 3);
    assert.equal(run.calls.filter((call) => call.label === `implement:${TASK}`).length, 3);
});

test("test_realMode_readsTheTestReviewFlagFromTheAgentResult", async () => {
    // Setup: codex flags the tests on the first two reviews, then accepts them.
    const run = await runReal({ "review-tests": (visit: number) => ({ flagged: visit < 3 }) });

    // Verification: result.flagged drove two amend rounds and then let the run reach the merge.
    assert.equal(countOf(run.trace, "amend tasks.json entry with codex's notes and fixes"), 2);
    assert.equal(run.error, null);
});

// --------------------------------------------------------------------------
// The dotted "agent() errored" edge, which FAKE mode fakes and real mode reads
// --------------------------------------------------------------------------

const AGENT_BOXES = REACHABLE_BOXES.slice(0, 4);
const SCRIPT_BOXES = REACHABLE_BOXES.slice(4);

for (const { role } of AGENT_BOXES) {
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

for (const { role } of SCRIPT_BOXES) {
    test(`test_realMode_endsRunFailedWhenTheGreenBox_${role.replace(/-/g, "_")}_ReturnsNothing`, async () => {
        // Setup: a green box performed by an agent loses its result.
        const run = await runReal({ [role]: null });

        // Verification: a green box draws no dotted edge; an operational failure is run-failed.
        assert.equal(run.error, null);
        assert.equal(countOf(run.trace, "agent() errored"), 0);
        assert.equal(exitTypeOf(run.trace), "RUN-FAILED");
    });
}

// The four migrated boxes are green [C] boxes too: a missing receipt is a run-failed, not the dotted edge.
const RUN_STEP_BOX_REACH: Record<string, Record<string, unknown>> = {
    "continue-rebase": { "rebase-worktree": { conflicted: true } },
};

for (const role of Object.values(RUN_STEP_ROLES)) {
    test(`test_realMode_endsRunFailedWhenTheGreenBox_${role.replace(/-/g, "_")}_ReturnsNothing`, async () => {
        // Setup: the harness loses that box's receipt, which reaches the workflow as a null result.
        const run = await runReal({ ...RUN_STEP_BOX_REACH[role], [role]: null });

        // Verification: a green box draws no dotted edge; an operational failure is run-failed.
        assert.equal(run.error, null);
        assert.equal(countOf(run.trace, "agent() errored"), 0);
        assert.equal(exitTypeOf(run.trace), "RUN-FAILED");
    });
}
