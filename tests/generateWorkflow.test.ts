import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepConfig } from "../scripts/generateSteps.ts";
import { assertStartStepIsInConfig, buildAgentSchemasByStartBlock, buildWorkflowScript, generateWorkflow, START_STEP, WORKFLOW_FILE } from "../scripts/generateWorkflow.ts";
import {
    buildAgentSchema,
    buildBlockSchemas,
    buildNextStepsByStep,
    buildWalkResultSchema,
    getPayloadFromOutput,
    getPromptStepKeys,
    getSchemaFromTemplate,
    getStepsReachableFrom,
} from "../scripts/buildRunStepSchemas.ts";

// Builds a throwaway project holding one steps.json and the template files it points at.
function buildProject(blocks: { box: string; output: Record<string, unknown>; producesPrompt?: boolean; next?: string[]; agentAnswer?: Record<string, unknown> }[]) {
    const projectRoot = mkdtempSync(join(tmpdir(), "generate-workflow-"));
    mkdirSync(join(projectRoot, "steps"));
    const entries = blocks.map(block => {
        const template: Record<string, unknown> = { input: {}, output: block.output };
        if (block.agentAnswer !== undefined) {
            template.agentAnswer = block.agentAnswer;
        }
        writeFileSync(join(projectRoot, "steps", `${block.box}.template.json`), JSON.stringify(template));
        return {
            box: block.box,
            script: `steps/${block.box}.ts`,
            template: `steps/${block.box}.template.json`,
            producesPrompt: block.producesPrompt ?? false,
            next: block.next ?? [],
        };
    });
    const config: StepConfig = { "one.mmd": entries };
    const configFile = join(projectRoot, "steps.json");
    writeFileSync(configFile, JSON.stringify(config));
    return { projectRoot, config, configFile };
}

test("test_buildWalkResultSchema_closesTheEnvelopeTheHookReturns", () => {
    const schema = buildWalkResultSchema() as Record<string, any>;
    const outcome = schema.properties.outcome.anyOf[0];
    assert.deepEqual(outcome.required, ["box", "scriptSignal", "workflowSignal", "next", "payload", "packetFile"]);
    assert.equal(outcome.additionalProperties, false);
});

// The envelope is shared, so the block shapes are left out until buildPossibleSchemas picks them.
test("test_buildWalkResultSchema_leavesThePayloadShapesEmpty", () => {
    const schema = buildWalkResultSchema() as Record<string, any>;
    assert.deepEqual(schema.properties.outcome.anyOf[0].properties.payload.anyOf, []);
});

// A walk that never reached a block has nothing to report, so outcome has to allow null.
test("test_buildWalkResultSchema_allowsAnOutcomeOfNull", () => {
    const schema = buildWalkResultSchema() as Record<string, any>;
    assert.deepEqual(schema.properties.outcome.anyOf[1], { type: "null" });
});

// The agent answers with a prompt block's answer shape; a continue or stop block has no schema.
test("test_buildBlockSchemas_namesASchemaOnlyForABlockTheWalkCanStopAt", () => {
    const { config, projectRoot } = buildProject([
        { box: "A", output: { box: "A", scriptSignal: "continue", files: 0 } },
        { box: "B", output: { box: "B", scriptSignal: "stop" } },
        { box: "C", output: {}, producesPrompt: true, agentAnswer: { answer: "" } },
    ]);
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    assert.deepEqual(blockSchemas.map(blockSchema => blockSchema.name), ["PAYLOAD_C_SCHEMA"]);
});

// A prompt block's pass hands on the agent's answer, so its schema comes from the block's own declared shape.
test("test_buildBlockSchemas_usesTheAgentAnswerShapeForAPromptBlock", () => {
    const agentAnswer = { outcome: "" };
    const { config, projectRoot } = buildProject([{ box: "A", output: {}, producesPrompt: true, agentAnswer }]);
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    assert.deepEqual(blockSchemas[0]!.schema, getSchemaFromTemplate(agentAnswer));
});

// Every producesPrompt block must declare its answer shape; there is no global fallback to drift against.
test("test_buildBlockSchemas_throwsWhenAPromptBlockDeclaresNoAgentAnswer", () => {
    const { config, projectRoot } = buildProject([{ box: "A", output: {}, producesPrompt: true }]);
    assert.throws(() => buildBlockSchemas(config, projectRoot), /declares no agentAnswer/);
});

// A pass ending before a prompt block, or at a STOP block, still needs a payload shape.
test("test_buildAgentSchema_endsThePayloadAnyOfWithTheEmptyObjectAlternative", () => {
    const { config, projectRoot } = buildProject([{ box: "A", output: {}, producesPrompt: true, agentAnswer: { answer: "" } }]);
    const schema = buildAgentSchema(config, projectRoot, "one.mmd::A") as Record<string, any>;
    const payloadSchemas = schema.properties.outcome.anyOf[0].properties.payload.anyOf;
    assert.deepEqual(payloadSchemas.at(-1), { type: "object", maxProperties: 0 });
});

// box, scriptSignal and next belong to the envelope, so a payload never repeats them.
test("test_getPayloadFromOutput_dropsTheKeysTheEnvelopeOwns", () => {
    assert.deepEqual(getPayloadFromOutput({ box: "A", scriptSignal: "continue", next: "B", files: 0 }), { files: 0 });
});

test("test_buildNextStepsByStep_keysEveryBoxByDiagramAndBox", () => {
    const { config } = buildProject([{ box: "A", output: {}, next: ["B"] }, { box: "B", output: {} }]);
    assert.deepEqual(buildNextStepsByStep(config), { "one.mmd::A": ["one.mmd::B"], "one.mmd::B": [] });
});

// A prompt block is a stopping block, so the walk does not follow its arrows.
test("test_buildNextStepsByStep_dropsTheArrowsOutOfAPromptBlock", () => {
    const { config } = buildProject([{ box: "A", output: {}, producesPrompt: true, next: ["B"] }, { box: "B", output: {} }]);
    assert.deepEqual(buildNextStepsByStep(config), { "one.mmd::A": [], "one.mmd::B": [] });
});

test("test_getStepsReachableFrom_followsASingleChainToItsEnd", () => {
    const nextStepsByStep = { A: ["B"], B: ["C"], C: [] };
    assert.deepEqual(getStepsReachableFrom("A", nextStepsByStep), ["A", "B", "C"]);
});

// A block script picks its own branch, so both arms belong in the same schema.
test("test_getStepsReachableFrom_takesEveryArmOfABranch", () => {
    const nextStepsByStep = { A: ["B"], B: ["C", "D"], C: [], D: [] };
    assert.deepEqual(getStepsReachableFrom("A", nextStepsByStep), ["A", "B", "C", "D"]);
});

test("test_getStepsReachableFrom_stopsWhenTheArrowsLoopBack", () => {
    const nextStepsByStep = { A: ["B"], B: ["A"] };
    assert.deepEqual(getStepsReachableFrom("A", nextStepsByStep), ["A", "B"]);
});

// The harness rejects a script unless meta is the first statement, so the generated comment comes after it.
test("test_buildWorkflowScript_startsWithAMetaBlockAndSaysNotToEditIt", () => {
    const script = buildWorkflowScript();
    assert.match(script, /Do not edit this file/);
    assert.ok(script.startsWith("export const meta = {\n    name: 'tackle-tasks',"));
});

test("test_buildWorkflowScript_loopsUntilTheWalkEndsOrFails", () => {
    const script = buildWorkflowScript();
    assert.match(script, /while \(true\) \{/);
    assert.match(script, /if \(result === null\) \{/);
    assert.match(script, /if \(result\.ok === false\) \{/);
    assert.match(script, /if \(result\.ran\.length === 0\) \{/);
    assert.match(script, /if \(result\.outcome\.workflowSignal === 'done'\) \{/);
});

// Every return names the prompt that produced it, so a failure says what was asked.
test("test_buildWorkflowScript_returnsTheEnvelopeAndThePromptThatMadeIt", () => {
    const script = buildWorkflowScript();
    assert.match(script, /return \{ ok: true, ran, errors: \[\], prompt, outcome: result\.outcome \}/);
    assert.doesNotMatch(script, /throw new Error\(`/);
});

// The preamble's first box reads exactly these two, so the workflow refuses to start without them.
test("test_buildWorkflowScript_refusesToRunWithoutATaskNumberAndATasksFileInArgs", () => {
    assert.match(buildWorkflowScript(), /if \(!Number\.isInteger\(args\?\.task\) \|\| !args\?\.tasksFile\)/);
});

// AGENT_SCHEMAS holds one envelope per block a pass can start at: START_STEP and every prompt block.
test("test_buildWorkflowScript_putsAnAgentSchemaKeyOnStartStepAndEveryPromptBlock", () => {
    const script = buildWorkflowScript();
    assert.match(script, /const START_STEP = 'pipeline-preambleStatusCheck\.mmd::PREAMBLE_STATUS_CHECK'/);
    assert.match(script, /^let blockToRun = START_STEP$/m);
    assert.match(script, /^let schema = AGENT_SCHEMAS\[START_STEP\]$/m);
    const listStart = script.indexOf("const AGENT_SCHEMAS = ") + "const AGENT_SCHEMAS = ".length;
    const agentSchemaKeys = Object.keys(JSON.parse(script.slice(listStart, script.indexOf("\n\n// Required:"))));
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const config = JSON.parse(readFileSync(join(projectRoot, "scripts", "steps.json"), "utf8")) as StepConfig;
    const expectedKeys = Object.keys(buildAgentSchemasByStartBlock());
    assert.ok(agentSchemaKeys.includes(START_STEP));
    for (const promptStepKey of getPromptStepKeys(config)) {
        assert.ok(agentSchemaKeys.includes(promptStepKey), `missing ${promptStepKey}`);
    }
    assert.deepEqual(agentSchemaKeys.sort(), expectedKeys.sort());
});

// After a prompt pass the next block reads the packetFile plus the answer.
test("test_buildWorkflowScript_mergesAPromptAnswerOntoTheHooksPacket", () => {
    const script = buildWorkflowScript();
    assert.match(script, /input = \{ packetFile: result\.outcome\.packetFile, \.\.\.result\.outcome\.payload \}/);
    assert.match(script, /input = \{ packetFile: result\.outcome\.packetFile \}$/m);
    assert.doesNotMatch(script, /lastPacket/);
});

// An agent that answers with text instead of the envelope must not crash the loop and lose that text.
test("test_buildWorkflowScript_reportsATextAnswerInsteadOfSpreadingIt", () => {
    const script = buildWorkflowScript();
    const textGuard = script.indexOf("if (typeof result === 'string') {");
    assert.ok(textGuard > 0, "no guard for a text answer");
    assert.ok(textGuard < script.indexOf("ran.push(...result.ran)"), "the guard comes after the spread");
});

test("test_buildWorkflowScript_takesTheNextStepFromTheHookResult", () => {
    const script = buildWorkflowScript();
    assert.match(script, /blockToRun = result\.outcome\.next/);
    assert.doesNotMatch(script, /NEXT_STEPS_BY_STEP/);
});

test("test_assertStartStepIsInConfig_throwsWhenTheStartStepIsMissing", () => {
    const { config } = buildProject([{ box: "A", output: {} }]);
    assert.throws(() => assertStartStepIsInConfig(config, "one.mmd::MISSING"), /is not a key in the config/);
});

test("test_assertStartStepIsInConfig_doesNotThrowWhenTheStartStepExists", () => {
    const { config } = buildProject([{ box: "A", output: {} }]);
    assert.doesNotThrow(() => assertStartStepIsInConfig(config, "one.mmd::A"));
});

test("test_generateWorkflow_writesTheScriptToTheGivenPath", () => {
    const { projectRoot } = buildProject([{ box: "A", output: { box: "A", scriptSignal: "stop" } }]);
    const workflowFile = join(projectRoot, "skills/tackle-tasks/tackle-tasks.workflow.js");
    generateWorkflow(workflowFile);
    assert.match(readFileSync(workflowFile, "utf8"), /export const meta/);
});

// npm run steps regenerates it; a hand edit or a stale copy shows up here.
test("test_generateWorkflow_theCommittedWorkflowIsUpToDate", () => {
    assert.equal(readFileSync(WORKFLOW_FILE, "utf8"), buildWorkflowScript());
});
