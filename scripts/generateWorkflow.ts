// Writes the run-step workflow from steps.json, with one schema per block built from that block's template.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockTemplate, StepConfig } from "./generateSteps.ts";
import { getSchemaFromTemplate } from "./templateSchema.ts";

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
    return `BLOCK_${box}_SCHEMA`;
}

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
                schema: getSchemaFromTemplate(template.output),
            });
        }
    }
    return blockSchemas;
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

// The hook always returns this envelope. buildPossibleSchemas fills in output, so it starts empty.
export function buildWalkResultSchema(): Record<string, unknown> {
    return {
        type: "object",
        properties: {
            ok: { type: "boolean" },
            ran: { type: "array", items: { type: "string" } },
            stoppedAt: { type: "string" },
            why: { type: "string" },
            isTerminal: { type: "boolean" },
            report: { type: "string" },
            output: { anyOf: [] },
        },
        required: ["ok", "ran", "stoppedAt", "why", "isTerminal", "report", "output"],
        additionalProperties: false,
    };
}

export function getFirstStep(config: StepConfig): string {
    const [firstDiagram = ""] = Object.keys(config);
    const firstEntries = config[firstDiagram] ?? [];
    return firstEntries[0] ? getStepKey(firstEntries[0].box, firstDiagram) : "";
}

function buildBlockSchemaText(blockSchemas: BlockSchema[]): string {
    const declarations = blockSchemas.map(blockSchema => {
        const schemaText = JSON.stringify(blockSchema.schema, null, 4);
        return `const ${blockSchema.name} = ${schemaText}`;
    });
    return declarations.join("\n\n");
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
    const walkResultSchemaText = JSON.stringify(buildWalkResultSchema(), null, 4);
    const nextStepsText = JSON.stringify(buildNextStepsByStep(config), null, 4);
    const reachableText = JSON.stringify(buildStepsReachableFrom(config), null, 4);
    const firstStepText = JSON.stringify(getFirstStep(config));
    return `// Generated by scripts/generateWorkflow.ts from scripts/steps.json. Do not edit this file.
export const meta = {
    name: 'run-step',
    description: 'Run one diagram block and every block that follows it, through the run-step hook',
    phases: [{ title: 'Run', detail: 'one agent per pass, until the walk reaches the end of a path' }],
}

// One schema per block, built from that block's output template, named after the block.
${blockSchemaText}

// Every block schema, keyed by diagram then box. buildPossibleSchemas picks from this.
${blockSchemaMapText}

// The envelope the hook always returns. Only output changes, so buildPossibleSchemas fills it in.
const WALK_RESULT_SCHEMA = ${walkResultSchemaText}

// The arrows out of every box, as they read in the diagram.
const NEXT_STEPS_BY_STEP = ${nextStepsText}

// How far one agent can walk from each box before a decision needs making.
const STEPS_REACHABLE_FROM = ${reachableText}

const FIRST_STEP = ${firstStepText}

// The next agent picks up where the walk stopped: the one arrow out, or the one the block named.
function getNextStep(result) {
    if (result === null) {
        return FIRST_STEP
    }
    const namedNext = result.output?.next
    if (namedNext === undefined) {
        return NEXT_STEPS_BY_STEP[result.stoppedAt][0]
    }
    const stoppedInDiagram = result.stoppedAt.split('::')[0]
    return namedNext.includes('::') ? namedNext : stoppedInDiagram + '::' + namedNext
}

// Only the blocks this agent can actually reach, plus a plain string for stdout a failed block left behind.
function buildPossibleSchemas(stepToStartAt, blockSchemas) {
    const outputSchemas = [{ type: 'string' }]
    for (const stepKey of STEPS_REACHABLE_FROM[stepToStartAt]) {
        const [diagram, box] = stepKey.split('::')
        outputSchemas.push(blockSchemas[diagram][box])
    }
    return { ...WALK_RESULT_SCHEMA, properties: { ...WALK_RESULT_SCHEMA.properties, output: { anyOf: outputSchemas } } }
}

phase('Run')

let result = null
while (true) {
    const stepToStartAt = getNextStep(result)
    const possibleSchemas = buildPossibleSchemas(stepToStartAt, BLOCK_SCHEMAS)
    result = await agent(stepToStartAt, { label: \`run-step:\${stepToStartAt}\`, schema: possibleSchemas })
    if (result.isTerminal) break
    if (result.report) break
    if (!result.ok) break
}

// the end of a path, something for the user to read, or a walk that could not go on
return result
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
