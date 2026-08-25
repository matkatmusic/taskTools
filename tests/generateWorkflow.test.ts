import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepConfig } from "../scripts/generateSteps.ts";
import { buildWorkflowScript, generateWorkflow, START_STEP, WORKFLOW_FILE } from "../scripts/generateWorkflow.ts";
import {
    buildBlockSchemas,
    buildNextStepsByStep,
    buildWalkResultSchema,
    getPayloadFromOutput,
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
    const schema = buildWalkResultSchema();
    assert.deepEqual(schema.required, ["ok", "ran", "errors", "outcome"]);
    assert.equal(schema.additionalProperties, false);
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

test("test_buildBlockSchemas_namesEachSchemaAfterItsBlock", () => {
    const { config, projectRoot } = buildProject([
        { box: "A", output: { box: "A", scriptSignal: "continue", files: 0 } },
        { box: "B", output: { box: "B", scriptSignal: "stop" } },
    ]);
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    assert.deepEqual(blockSchemas.map(blockSchema => blockSchema.name), ["PAYLOAD_A_SCHEMA", "PAYLOAD_B_SCHEMA"]);
});

// The point of the whole task: the schema is the template, not a hand-written copy of it.
test("test_buildBlockSchemas_buildsEachShapeFromThatBlocksTemplate", () => {
    const output = { box: "A", scriptSignal: "continue", files: 0 };
    const { config, projectRoot } = buildProject([{ box: "A", output }]);
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    assert.deepEqual(blockSchemas[0]!.schema, getSchemaFromTemplate({ files: 0 }));
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

// box, scriptSignal and next belong to the envelope, so a payload never repeats them.
test("test_getPayloadFromOutput_dropsTheKeysTheEnvelopeOwns", () => {
    assert.deepEqual(getPayloadFromOutput({ box: "A", scriptSignal: "continue", next: "B", files: 0 }), { files: 0 });
});

test("test_buildNextStepsByStep_keysEveryBoxByDiagramAndBox", () => {
    const { config } = buildProject([{ box: "A", output: {}, next: ["B"] }, { box: "B", output: {} }]);
    assert.deepEqual(buildNextStepsByStep(config), { "one.mmd::A": ["one.mmd::B"], "one.mmd::B": [] });
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

// The first pass may stop at any block the start can reach, so its schema names all of them; the hook shrinks it from there.
test("test_buildWorkflowScript_startsAtThePreamblesFirstBoxWithEveryReachableBlockInItsFirstSchema", () => {
    const script = buildWorkflowScript();
    assert.match(script, /const START_STEP = 'pipeline-preambleStatusCheck\.mmd::PREAMBLE_TASK_NUMBER_INPUT'/);
    assert.match(script, /^let blockToRun = START_STEP$/m);
    const schemaStart = script.indexOf("const FIRST_PASS_SCHEMA = ") + "const FIRST_PASS_SCHEMA = ".length;
    const schema = JSON.parse(script.slice(schemaStart, script.indexOf("\n\n// Required")));
    const stepsFile = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "steps.json");
    const config = JSON.parse(readFileSync(stepsFile, "utf8")) as StepConfig;
    const reachable = getStepsReachableFrom(START_STEP, buildNextStepsByStep(config));
    assert.ok(reachable.length > 100, `only ${reachable.length} blocks reachable from the start`);
    assert.equal(schema.properties.outcome.anyOf[0].properties.payload.anyOf.length, reachable.length);
});

test("test_buildWorkflowScript_takesTheNextStepFromTheHookResult", () => {
    const script = buildWorkflowScript();
    assert.match(script, /blockToRun = result\.outcome\.next/);
    assert.doesNotMatch(script, /NEXT_STEPS_BY_STEP/);
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
