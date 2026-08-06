// Behavioral checks for the retryAgent helper duplicated across the tackle-tasks workflow files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_NAMES = ["plan", "verify", "implement", "test", "merge"];
const EXPECTED_AGENT_CALLS: Record<string, number> = { plan: 1, verify: 1, implement: 1, test: 2, merge: 1 };
const HELPER_MARKER = "// ponytail: null/undefined means the harness returned no result";

const readWorkflow = (name: string) =>
    readFileSync(join(import.meta.dirname, "..", "skills", "tackle-tasks", `${name}.workflow.js`), "utf8");

const extractHelper = (source: string) => {
    const start = source.indexOf(HELPER_MARKER);
    assert.notEqual(start, -1, "workflow file declares no retryAgent helper");
    const end = source.indexOf("\n}\n", start);
    assert.notEqual(end, -1, "retryAgent helper has no closing brace");
    return source.slice(start, end + 3);
};

// The workflow files cannot be imported, so compile the extracted helper text instead.
const loadRetryAgent = () =>
    new Function(`${extractHelper(readWorkflow("plan"))}\nreturn retryAgent`)();

const countingSpawn = (results: unknown[]) => {
    const spawn = () => { spawn.calls++; return Promise.resolve(results[spawn.calls - 1]); };
    spawn.calls = 0;
    return spawn;
};

test("test_retryAgentSucceedsOnRetry", async () => {
    // A null first attempt must be re-spawned once, and the second result returned.
    const retryAgent = loadRetryAgent();
    const spawn = countingSpawn([null, { ok: 1 }]);
    assert.deepEqual(await retryAgent(spawn), { ok: 1 });
    assert.equal(spawn.calls, 2);
});

test("test_retryAgentRetriesUndefined", async () => {
    // undefined is a missing result too, so it must retry exactly like null does.
    const retryAgent = loadRetryAgent();
    const spawn = countingSpawn([undefined, { ok: 1 }]);
    assert.deepEqual(await retryAgent(spawn), { ok: 1 });
    assert.equal(spawn.calls, 2);
});

test("test_retryAgentPreservesFalsyZero", async () => {
    // 0 is a valid result; a truthiness check would wrongly re-spawn it.
    const retryAgent = loadRetryAgent();
    const spawn = countingSpawn([0, { ok: 1 }]);
    assert.equal(await retryAgent(spawn), 0);
    assert.equal(spawn.calls, 1);
});

test("test_retryAgentStopsAfterThreeFailures", async () => {
    // Three null results exhaust the attempts and yield null without a fourth spawn.
    const retryAgent = loadRetryAgent();
    const spawn = countingSpawn([null, null, null, { ok: 1 }]);
    assert.equal(await retryAgent(spawn), null);
    assert.equal(spawn.calls, 3);
});

test("test_everyWorkflowFileDeclaresTheIdenticalRetryHelper", () => {
    // The helper is duplicated per file because the sandbox forbids imports; the copies must not drift.
    const helpers = WORKFLOW_NAMES.map((name) => extractHelper(readWorkflow(name)));
    for (const helper of helpers) assert.equal(helper, helpers[0]);
});

const agentCallCounts = (source: string) => ({
    total: source.split("agent(").length - 1,
    wrapped: source.split("retryAgent(() => agent(").length - 1,
});

test("test_everyAgentCallUsesRetryAgent", () => {
    // A bare agent() call would still pass the helper tests above, so gate the production wiring here.
    for (const name of WORKFLOW_NAMES) {
        const counts = agentCallCounts(readWorkflow(name));
        assert.equal(counts.total, EXPECTED_AGENT_CALLS[name], `${name}.workflow.js agent() call count`);
        assert.equal(counts.wrapped, counts.total, `${name}.workflow.js has an unwrapped agent() call`);
    }
});

test("test_theWiringGateFailsOnADirectAgentCall", () => {
    // Negative control: the gate must reject a file holding one unwrapped call.
    const counts = agentCallCounts("const x = await agent(brief, options)\n");
    assert.equal(counts.total, 1);
    assert.notEqual(counts.wrapped, counts.total);
});

// Bun's ESM build rejects these files outright, so wrap them in the sandbox shape to parse them.
const parseInSandboxShape = (source: string) => {
    const body = source.replace("export const meta", "const meta");
    new Function(`(async () => {\n${body}\n})()`);
};

test("test_everyWorkflowFileParsesInItsSandboxShape", () => {
    // Top-level await and top-level return are legal in the sandbox; a syntax error must fail the run.
    for (const name of WORKFLOW_NAMES) {
        assert.doesNotThrow(() => parseInSandboxShape(readWorkflow(name)), `${name}.workflow.js does not parse`);
    }
});

test("test_theParseGateFailsOnBrokenSource", () => {
    // Negative control: proves the parse gate is able to fail.
    assert.throws(() => parseInSandboxShape("export const meta = {\nconst broken ==== 1\n"), SyntaxError);
});
