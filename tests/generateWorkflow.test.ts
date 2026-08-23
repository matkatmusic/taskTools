import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepConfig } from "../scripts/generateSteps.ts";
import { buildWorkflowScript, generateWorkflow } from "../scripts/generateWorkflow.ts";
import {
    buildBlockSchemas,
    buildNextStepsByStep,
    buildWalkResultSchema,
    getPayloadFromOutput,
    getSchemaFromTemplate,
    getStepsReachableFrom,
} from "../scripts/buildRunStepSchemas.ts";

// Builds a throwaway project holding one steps.json and the template files it points at.
function buildProject(blocks: { box: string; output: Record<string, unknown>; next?: string[] }[]) {
    const projectRoot = mkdtempSync(join(tmpdir(), "generate-workflow-"));
    mkdirSync(join(projectRoot, "steps"));
    const entries = blocks.map(block => {
        const template = { input: {}, output: block.output };
        writeFileSync(join(projectRoot, "steps", `${block.box}.template.json`), JSON.stringify(template));
        return {
            box: block.box,
            script: `steps/${block.box}.ts`,
            template: `steps/${block.box}.template.json`,
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
        { box: "A", output: { box: "A", signal: "continue", files: 0 } },
        { box: "B", output: { box: "B", signal: "stop" } },
    ]);
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    assert.deepEqual(blockSchemas.map(blockSchema => blockSchema.name), ["PAYLOAD_A_SCHEMA", "PAYLOAD_B_SCHEMA"]);
});

// The point of the whole task: the schema is the template, not a hand-written copy of it.
test("test_buildBlockSchemas_buildsEachShapeFromThatBlocksTemplate", () => {
    const output = { box: "A", signal: "continue", files: 0 };
    const { config, projectRoot } = buildProject([{ box: "A", output }]);
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    assert.deepEqual(blockSchemas[0]!.schema, getSchemaFromTemplate({ files: 0 }));
});

// box, signal and next belong to the envelope, so a payload never repeats them.
test("test_getPayloadFromOutput_dropsTheKeysTheEnvelopeOwns", () => {
    assert.deepEqual(getPayloadFromOutput({ box: "A", signal: "continue", next: "B", files: 0 }), { files: 0 });
});

test("test_buildNextStepsByStep_keysEveryBoxByDiagramAndBox", () => {
    const { config } = buildProject([{ box: "A", output: {}, next: ["B"] }, { box: "B", output: {} }]);
    assert.deepEqual(buildNextStepsByStep(config), { "one.mmd::A": ["one.mmd::B"], "one.mmd::B": [] });
});

test("test_getStepsReachableFrom_followsASingleChainToItsEnd", () => {
    const nextStepsByStep = { A: ["B"], B: ["C"], C: [] };
    assert.deepEqual(getStepsReachableFrom("A", nextStepsByStep, []), ["A", "B", "C"]);
});

// A block script picks its own branch, so both arms belong in the same schema.
test("test_getStepsReachableFrom_takesEveryArmOfABranch", () => {
    const nextStepsByStep = { A: ["B"], B: ["C", "D"], C: [], D: [] };
    assert.deepEqual(getStepsReachableFrom("A", nextStepsByStep, []), ["A", "B", "C", "D"]);
});

// An agent answers a prompt block, so what follows it belongs to the next pass.
test("test_getStepsReachableFrom_stopsAtAPromptBlock", () => {
    const nextStepsByStep = { A: ["B"], B: ["C", "D"], C: [], D: [] };
    assert.deepEqual(getStepsReachableFrom("A", nextStepsByStep, ["B"]), ["A", "B"]);
});

test("test_getStepsReachableFrom_stopsWhenTheArrowsLoopBack", () => {
    const nextStepsByStep = { A: ["B"], B: ["A"] };
    assert.deepEqual(getStepsReachableFrom("A", nextStepsByStep, []), ["A", "B"]);
});

test("test_buildWorkflowScript_startsWithAMetaBlockAndSaysNotToEditIt", () => {
    const script = buildWorkflowScript();
    assert.match(script, /Do not edit this file/);
    assert.match(script, /export const meta = \{\n {4}name: 'run-step',/);
});

test("test_buildWorkflowScript_loopsUntilTheWalkEndsOrFails", () => {
    const script = buildWorkflowScript();
    assert.match(script, /while \(true\) \{/);
    assert.match(script, /if \(result === null\) \{/);
    assert.match(script, /if \(result\.ok === false\) \{/);
    assert.match(script, /if \(result\.ran\.length === 0\) \{/);
    assert.match(script, /if \(result\.outcome\.next === null\) \{/);
});

// Every return names the prompt that produced it, so a failure says what was asked.
test("test_buildWorkflowScript_returnsTheEnvelopeAndThePromptThatMadeIt", () => {
    const script = buildWorkflowScript();
    assert.match(script, /return \{ ok: true, ran, errors: \[\], prompt, outcome: result\.outcome \}/);
    assert.doesNotMatch(script, /throw new Error\(`/);
});

// The caller says where to start, so a diagram edit never needs the workflow regenerated for it.
test("test_buildWorkflowScript_refusesToRunWithoutAStartStepInArgs", () => {
    assert.match(buildWorkflowScript(), /if \(!args\?\.startStep\)/);
});

// The whole point of the first-pass schema: no block shape is baked in, so no diagram can stale it.
test("test_buildWorkflowScript_bakesInNoBlockShapes", () => {
    const script = buildWorkflowScript();
    assert.doesNotMatch(script, /BOOTSTRAP_SCHEMAS/);
    assert.doesNotMatch(script, /PAYLOAD_|AGENT_OUTPUT_|STEPS_REACHABLE_FROM/);
});

test("test_buildWorkflowScript_takesTheNextStepFromTheHookResult", () => {
    const script = buildWorkflowScript();
    assert.match(script, /blockToRun = result\.outcome\.next/);
    assert.doesNotMatch(script, /NEXT_STEPS_BY_STEP/);
});

test("test_generateWorkflow_writesTheScriptToTheGivenPath", () => {
    const { projectRoot } = buildProject([{ box: "A", output: { box: "A", signal: "stop" } }]);
    const workflowFile = join(projectRoot, ".claude/workflows/run-step.workflow.js");
    generateWorkflow(workflowFile);
    assert.match(readFileSync(workflowFile, "utf8"), /export const meta/);
});
