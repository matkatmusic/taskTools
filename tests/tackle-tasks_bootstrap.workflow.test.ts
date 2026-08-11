import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = join(REPO_ROOT, "skills/tackle-tasks/bootstrap.workflow.js");
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8").replace("export const meta", "const meta");

type AgentImpl = (prompt: string, options: { label: string; schema: unknown }) => Promise<unknown>;
type WorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: AgentImpl) => Promise<unknown>;

function runBootstrapWorkflow(argsObj: Record<string, unknown>, agentImpl: AgentImpl) {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ["args", "log", "agent"],
    { filename: WORKFLOW_PATH, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as WorkflowRunner;
  return fn(JSON.stringify(argsObj), () => {}, agentImpl);
}

test("discover mode's agent prompt runs the emitter via Bash with the given mode and args, and passes the schema-validated result through", async () => {
  let capturedPrompt = "";
  let capturedOptions: { label: string; schema: unknown } | null = null;
  const result = await runBootstrapWorkflow(
    { mode: "discover", argsValue: "[1,2] valid", bootstrapAgentPromptEmitterPath: "/abs/path/to/emitter.ts" },
    async (prompt, options) => {
      capturedPrompt = prompt;
      capturedOptions = options;
      return { blockerPairs: [], unblockedNumbers: [1, 2] };
    },
  );
  assert.match(capturedPrompt, /node "\/abs\/path\/to\/emitter\.ts" discover <<'BOOTSTRAP_PAYLOAD'/);
  assert.match(capturedPrompt, /\[1,2\] valid/);
  assert.equal(capturedOptions!.label, "bootstrap:discover");
  assert.deepEqual(result, { blockerPairs: [], unblockedNumbers: [1, 2] });
});

test("prepare mode requests the prepare schema and passes the result through unchanged", async () => {
  const preparedResult = { taskDetails: [], pipelineArgs: { repo: "/r" }, maxConcurrency: 6 };
  let capturedOptions: { label: string; schema: unknown } | null = null;
  const result = await runBootstrapWorkflow(
    { mode: "prepare", argsValue: "[1]", bootstrapAgentPromptEmitterPath: "/abs/path/to/emitter.ts" },
    async (_prompt, options) => {
      capturedOptions = options;
      return preparedResult;
    },
  );
  assert.equal(capturedOptions!.label, "bootstrap:prepare");
  assert.deepEqual(result, preparedResult);
});

test("retries a null agent result up to 3 times before throwing", async () => {
  let attempts = 0;
  await assert.rejects(
    () => runBootstrapWorkflow(
      { mode: "discover", argsValue: "[1]", bootstrapAgentPromptEmitterPath: "/e.ts" },
      async () => { attempts += 1; return null; },
    ),
    /returned no result after 3 attempts/,
  );
  assert.equal(attempts, 3);
});

test("rejects an unknown mode before ever calling the agent", async () => {
  let called = false;
  await assert.rejects(
    () => runBootstrapWorkflow(
      { mode: "bogus", argsValue: "[1]", bootstrapAgentPromptEmitterPath: "/e.ts" },
      async () => { called = true; return {}; },
    ),
    /unknown mode "bogus"/,
  );
  assert.equal(called, false);
});
