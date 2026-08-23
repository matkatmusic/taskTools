// Writes the run-step workflow from steps.json, with one schema per block built from that block's template.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockTemplate, StepConfig } from "./generateSteps.ts";
import { getPayloadFromOutput, getSchemaFromTemplate } from "./templateSchema.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = join(PROJECT_ROOT, "scripts/steps.json");
const WORKFLOW_FILE = join(PROJECT_ROOT, ".claude/workflows/run-step.workflow.js");

export type BlockSchema = {
    diagram: string;
    box: string;
    name: string;
    schema: Record<string, unknown>;
};

export function getBlockSchemaName(box: string): string {
    return `PAYLOAD_${box}_SCHEMA`;
}

export { getPayloadFromOutput };

// A bare name belongs to the diagram that wrote it; a name holding :: already points across a seam.
export function getStepKey(target: string, diagram: string): string {
    return target.includes("::") ? target : `${diagram}::${target}`;
}

// One entry per block, so every schema in the generated file is named after the block it came from.
export function buildBlockSchemas(config: StepConfig, projectRoot: string): BlockSchema[] {
    const blockSchemas: BlockSchema[] = [];
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            const templateText = readFileSync(join(projectRoot, entry.template), "utf8");
            const template = JSON.parse(templateText) as BlockTemplate;
            blockSchemas.push({
                diagram,
                box: entry.box,
                name: getBlockSchemaName(entry.box),
                schema: getSchemaFromTemplate(getPayloadFromOutput(template.output)),
            });
        }
    }
    return blockSchemas;
}

export function getAgentOutputSchemaName(box: string): string {
    return `AGENT_OUTPUT_${box}_SCHEMA`;
}

// Only a prompt block declares agentOutput: the shape the agent fills in and returns.
export function buildAgentOutputSchemas(config: StepConfig, projectRoot: string): BlockSchema[] {
    const agentOutputSchemas: BlockSchema[] = [];
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            const templateText = readFileSync(join(projectRoot, entry.template), "utf8");
            const template = JSON.parse(templateText) as BlockTemplate;
            if (template.agentOutput === undefined) {
                continue;
            }
            agentOutputSchemas.push({
                diagram,
                box: entry.box,
                name: getAgentOutputSchemaName(entry.box),
                schema: getSchemaFromTemplate(template.agentOutput),
            });
        }
    }
    return agentOutputSchemas;
}

export function buildNextStepsByStep(config: StepConfig): Record<string, string[]> {
    const nextStepsByStep: Record<string, string[]> = {};
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            nextStepsByStep[getStepKey(entry.box, diagram)] = entry.next.map(target => getStepKey(target, diagram));
        }
    }
    return nextStepsByStep;
}

// A box with more than one arrow out needs an agent to choose, so the run cannot reach past it.
export function getStepsReachableFrom(startStepKey: string, nextStepsByStep: Record<string, string[]>): string[] {
    const reachedSteps: string[] = [];
    let stepKey = startStepKey;
    while (!reachedSteps.includes(stepKey)) {
        reachedSteps.push(stepKey);
        const successors = nextStepsByStep[stepKey] ?? [];
        if (successors.length !== 1) {
            return reachedSteps;
        }
        stepKey = successors[0]!;
    }
    return reachedSteps;
}

export function buildStepsReachableFrom(config: StepConfig): Record<string, string[]> {
    const nextStepsByStep = buildNextStepsByStep(config);
    const stepsReachableFrom: Record<string, string[]> = {};
    for (const stepKey of Object.keys(nextStepsByStep)) {
        stepsReachableFrom[stepKey] = getStepsReachableFrom(stepKey, nextStepsByStep);
    }
    return stepsReachableFrom;
}

// The hook always returns this envelope. buildPossibleSchemas fills in payload, so it starts empty.
export function buildWalkResultSchema(): Record<string, unknown> {
    const outcome = {
        type: "object",
        properties: {
            box: { type: "string" },
            signal: { type: "string", enum: ["continue", "stop", "prompt"] },
            next: { type: ["string", "null"] },
            payload: { anyOf: [] },
            schema: { type: ["object", "null"] },
        },
        required: ["box", "signal", "next", "payload", "schema"],
        additionalProperties: false,
    };
    return {
        type: "object",
        properties: {
            ok: { type: "boolean" },
            ran: { type: "array", items: { type: "string" } },
            errors: { type: "array", items: { type: "string" } },
            // A walk that never reached a block has no outcome to report.
            outcome: { anyOf: [outcome, { type: "null" }] },
        },
        required: ["ok", "ran", "errors", "outcome"],
        additionalProperties: false,
    };
}

function buildBlockSchemaText(blockSchemas: BlockSchema[]): string {
    const declarations = blockSchemas.map(blockSchema => {
        const schemaText = JSON.stringify(blockSchema.schema, null, 4);
        return `const ${blockSchema.name} = ${schemaText}`;
    });
    return declarations.join("\n\n");
}

// Keyed by the full step key, so the loop looks one up without splitting the name apart.
function buildAgentOutputSchemaMapText(agentOutputSchemas: BlockSchema[]): string {
    const lines: string[] = ["const AGENT_OUTPUT_SCHEMAS = {"];
    for (const agentOutputSchema of agentOutputSchemas) {
        const stepKey = `${agentOutputSchema.diagram}::${agentOutputSchema.box}`;
        lines.push(`    ${JSON.stringify(stepKey)}: ${agentOutputSchema.name},`);
    }
    lines.push("}");
    return lines.join("\n");
}

function buildBlockSchemaMapText(config: StepConfig): string {
    const lines: string[] = ["const BLOCK_SCHEMAS = {"];
    for (const [diagram, entries] of Object.entries(config)) {
        lines.push(`    ${JSON.stringify(diagram)}: {`);
        for (const entry of entries) {
            lines.push(`        ${entry.box}: ${getBlockSchemaName(entry.box)},`);
        }
        lines.push("    },");
    }
    lines.push("}");
    return lines.join("\n");
}

export function buildWorkflowScript(config: StepConfig, projectRoot: string): string {
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    const blockSchemaText = buildBlockSchemaText(blockSchemas);
    const blockSchemaMapText = buildBlockSchemaMapText(config);
    const agentOutputSchemas = buildAgentOutputSchemas(config, projectRoot);
    const agentOutputSchemaText = buildBlockSchemaText(agentOutputSchemas);
    const agentOutputSchemaMapText = buildAgentOutputSchemaMapText(agentOutputSchemas);
    const walkResultSchemaText = JSON.stringify(buildWalkResultSchema(), null, 4);
    const reachableText = JSON.stringify(buildStepsReachableFrom(config), null, 4);
    return `// Generated by scripts/generateWorkflow.ts from scripts/steps.json. Do not edit this file.
export const meta = {
    name: 'run-step',
    description: 'Run one diagram block and every block that follows it, through the run-step hook',
    // The real titles are diagram file names, named at run time, so this entry is the shape only.
    phases: [{ title: 'walk', detail: 'one agent per pass, grouped by the diagram it is walking' }],
}

// One payload schema per block, built from that block's output template, named after the block.
${blockSchemaText}

// Every payload schema, keyed by diagram then box. buildPossibleSchemas picks from this.
${blockSchemaMapText}

// One per prompt block: the shape the agent fills in after following that block's prompt.
${agentOutputSchemaText}

// Those same schemas, keyed by full step key. A step missing here is not a prompt block.
${agentOutputSchemaMapText}

// The envelope the hook always returns. Only payload changes, so buildPossibleSchemas fills it in.
const WALK_RESULT_SCHEMA = ${walkResultSchemaText}

// How far one agent can walk from each box before a decision needs making.
const STEPS_REACHABLE_FROM = ${reachableText}

// Required: the caller names the step this run starts at, as "diagram.mmd::BOX".
if (!args?.startStep) {
    throw new Error('run-step needs args.startStep, for example "pipeline-plan.mmd::DOCS_INPUT"')
}

// Only the blocks this agent can reach, plus a string for stdout a failed block left behind.
function buildPossibleSchemas(stepToStartAt) {
    const payloadSchemas = [{ type: 'string' }]
    for (const stepKey of STEPS_REACHABLE_FROM[stepToStartAt]) {
        const [diagram, box] = stepKey.split('::')
        payloadSchemas.push(BLOCK_SCHEMAS[diagram][box])
        // A prompt block lets the agent put its own answer in payload instead.
        if (AGENT_OUTPUT_SCHEMAS[stepKey]) {
            payloadSchemas.push(AGENT_OUTPUT_SCHEMAS[stepKey])
        }
    }
    const outcome = WALK_RESULT_SCHEMA.properties.outcome.anyOf[0]
    const filledOutcome = { ...outcome, properties: { ...outcome.properties, payload: { anyOf: payloadSchemas } } }
    const properties = { ...WALK_RESULT_SCHEMA.properties, outcome: { anyOf: [filledOutcome, { type: 'null' }] } }
    return { ...WALK_RESULT_SCHEMA, properties }
}

function createPromptForAgent(blockToRun) {
    // The envelope belongs to the hook. Saying so stops the agent authoring one of its own.
    return [
        \`run /run-step \${blockToRun} and follow instructions.\`,
        'Return the result object the hook gave you, exactly as it gave it to you. Change nothing in it.',
        'One exception. If that result carries a prompt for you to follow, follow it, then return the same object with your answer as outcome.payload.',
    ].join('\\n')
}

let blockToRun = args.startStep
// Only ran accumulates across passes. Everything else belongs to the pass that produced it.
const ran = []
while (true) {
    // Grouped by diagram, so crossing a :: seam opens a new group in the progress tree.
    phase(blockToRun.split('::')[0])
    const prompt = createPromptForAgent(blockToRun)
    // The first pass uses the schema built here; later passes use the one the hook sent.
    const result = await agent(prompt, { label: \`run-step:\${blockToRun}\`, schema: buildPossibleSchemas(blockToRun) })

    // API error. the only shape agent() produces that is not the envelope.
    if (result === null) {
        return { ok: false, ran, errors: [\`\${blockToRun}: agent died or was skipped\`], prompt, outcome: null }
    }
    ran.push(...result.ran)

    // script exited non-zero, block was unknown, or output came back as a string.
    if (result.ok === false) {
        return { ok: false, ran, errors: result.errors, prompt, outcome: result.outcome }
    }

    // agent never ran /run-step, made up fields, or reworded them; hook threw or returned nothing.
    if (result.ran.length === 0) {
        return { ok: false, ran, errors: [\`\${blockToRun}: agent answered without a hook envelope\`], prompt, outcome: null }
    }

    // nothing follows the block the walk stopped at, so this run is done.
    if (result.outcome.next === null) {
        return { ok: true, ran, errors: [], prompt, outcome: result.outcome }
    }
    blockToRun = result.outcome.next
}
`;
}

export function generateWorkflow(configFile: string, workflowFile: string, projectRoot: string): string {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as StepConfig;
    const workflowScript = buildWorkflowScript(config, projectRoot);
    mkdirSync(dirname(workflowFile), { recursive: true });
    writeFileSync(workflowFile, workflowScript);
    return workflowScript;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    generateWorkflow(CONFIG_FILE, WORKFLOW_FILE, PROJECT_ROOT);
    console.log(`wrote ${WORKFLOW_FILE.slice(PROJECT_ROOT.length + 1)}`);
}
