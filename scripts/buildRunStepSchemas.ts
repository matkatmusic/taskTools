// Every run-step schema, built from the block template files. The hook and the workflow generator share it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_SCRIPT_SIGNALS, WORKFLOW_SIGNAL } from "./contracts.ts";
import type { BlockTemplate, StepConfig } from "./generateSteps.ts";

export type BlockSchema = {
    diagram: string;
    box: string;
    name: string;
    schema: Record<string, unknown>;
};

// The envelope owns these, so a block's payload is whatever its output declares beyond them.
const ENVELOPE_OWNED_KEYS = ["box", "scriptSignal", "next"];

export function getPayloadFromOutput(output: unknown): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
        if (!ENVELOPE_OWNED_KEYS.includes(key)) {
            payload[key] = value;
        }
    }
    return payload;
}

// Turns a template's example object into a JSON Schema, so StructuredOutput cannot drift from the template.

// Strict on purpose: the key set is closed and every key is required, matching how templateShape compares.
export function getSchemaFromTemplate(example: unknown): Record<string, unknown> {
    if (example === null) {
        return { type: "null" };
    }
    if (Array.isArray(example)) {
        const firstItem = example[0];
        if (firstItem === undefined) {
            return { type: "array" };
        }
        return { type: "array", items: getSchemaFromTemplate(firstItem) };
    }
    if (typeof example === "object") {
        const properties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(example as Record<string, unknown>)) {
            properties[key] = getSchemaFromTemplate(value);
        }
        return {
            type: "object",
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
        };
    }
    return { type: typeof example };
}

export function getBlockSchemaName(box: string): string {
    return `PAYLOAD_${box}_SCHEMA`;
}

// A bare name belongs to the diagram that wrote it; a name holding :: already points across a seam.
export function getStepKey(target: string, diagram: string): string {
    return target.includes("::") ? target : `${diagram}::${target}`;
}

// One entry per block. A prompt block's pass hands on the agent's answer, so that is its schema.
export function buildBlockSchemas(config: StepConfig, projectRoot: string): BlockSchema[] {
    const blockSchemas: BlockSchema[] = [];
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            const templateText = readFileSync(resolve(projectRoot, entry.template), "utf8");
            const template = JSON.parse(templateText) as BlockTemplate;
            if (entry.producesPrompt) {
                if (template.agentAnswer === undefined) {
                    throw new Error(`${entry.template} declares no agentAnswer, and ${entry.box} is marked producesPrompt`);
                }
                blockSchemas.push({
                    diagram,
                    box: entry.box,
                    name: getBlockSchemaName(entry.box),
                    schema: getSchemaFromTemplate(template.agentAnswer),
                });
                continue;
            }
            if (template.output === undefined) {
                throw new Error(`${entry.template} declares no output, and ${entry.box} is not marked returns_a_prompt`);
            }
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

export function buildNextStepsByStep(config: StepConfig): Record<string, string[]> {
    const nextStepsByStep: Record<string, string[]> = {};
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            nextStepsByStep[getStepKey(entry.box, diagram)] = entry.next.map(target => getStepKey(target, diagram));
        }
    }
    return nextStepsByStep;
}

// A block script picks its own branch, so a walk can reach every block down every arrow, prompt blocks included.
export function getStepsReachableFrom(startStepKey: string, nextStepsByStep: Record<string, string[]>): string[] {
    const reachedSteps: string[] = [];
    const stepsToVisit = [startStepKey];
    while (stepsToVisit.length > 0) {
        const stepKey = stepsToVisit.shift()!;
        if (reachedSteps.includes(stepKey)) {
            continue;
        }
        reachedSteps.push(stepKey);
        stepsToVisit.push(...(nextStepsByStep[stepKey] ?? []));
    }
    return reachedSteps;
}

/* retired: the schema walks through prompt blocks now, so nothing asks which blocks prompt.
export function getPromptStepKeys(config: StepConfig): string[] {
    const promptStepKeys: string[] = [];
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            if (entry.producesPrompt) {
                promptStepKeys.push(getStepKey(entry.box, diagram));
            }
        }
    }
    return promptStepKeys;
}
*/

// The envelope the hook always returns. buildAgentSchema fills in payload, so it starts empty.
export function buildWalkResultSchema(): Record<string, unknown> {
    const outcome = {
        type: "object",
        properties: {
            box: { type: "string" },
            scriptSignal: { type: "string", enum: KNOWN_SCRIPT_SIGNALS },
            workflowSignal: { type: "string", enum: Object.values(WORKFLOW_SIGNAL) },
            next: { type: ["string", "null"] },
            payload: { anyOf: [] },
            schema: { type: ["object", "null"] },
        },
        required: ["box", "scriptSignal", "workflowSignal", "next", "payload", "schema"],
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

// The schema one agent answers with: every payload the run can still produce from this step. The list only shrinks.
export function buildAgentSchema(config: StepConfig, projectRoot: string, startStepKey: string): Record<string, unknown> {
    const reachableSteps = getStepsReachableFrom(startStepKey, buildNextStepsByStep(config));
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    const payloadSchemas: Record<string, unknown>[] = [];
    for (const stepKey of reachableSteps) {
        for (const blockSchema of blockSchemas) {
            if (`${blockSchema.diagram}::${blockSchema.box}` === stepKey) {
                payloadSchemas.push(blockSchema.schema);
            }
        }
    }
    const envelope = buildWalkResultSchema() as Record<string, any>;
    envelope.properties.outcome.anyOf[0].properties.payload = { anyOf: payloadSchemas };
    return envelope;
}

// The first pass knows no diagram, so its payload stays open. The hook names every shape after it.
export function buildFirstPassSchema(): Record<string, unknown> {
    const envelope = buildWalkResultSchema() as Record<string, any>;
    envelope.properties.outcome.anyOf[0].properties.payload = { type: "object" };
    return envelope;
}
