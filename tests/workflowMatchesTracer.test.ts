// Diffs tackle-tasks.workflow.js against tracePipeline.ts for every fixture.  The workflow uses top-level return, so compileFunction evaluates it, not import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";
import { traceTaskPipeline, readNamedPaths, type PipelineDecisions } from "../scripts/tracePipeline.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = join(REPO_ROOT, "skills/tackle-tasks/tackle-tasks.workflow.js");
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8").replace("export const meta", "const meta");

async function runWorkflow(fake: PipelineDecisions): Promise<string[]> {
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent", "phase"],
        { filename: WORKFLOW_PATH, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as (args: unknown, log: (...values: unknown[]) => void, agent: unknown, phase: unknown) => Promise<string[]>;
    return fn({ fake, task: fake.taskNumber }, () => {}, async () => {
        throw new Error("real agent() should never be called in fake mode");
    }, () => {});
}

const paths = readNamedPaths();

for (const [name, decisions] of Object.entries(paths)) {
    test(`workflow matches tracer: ${name}`, async () => {
        const expected = traceTaskPipeline(decisions);
        const actual = await runWorkflow(decisions);
        assert.deepEqual(actual, expected);
    });
}
