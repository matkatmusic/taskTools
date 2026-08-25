// Every run-step schema, built from the block template files. The hook and the workflow generator share it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_SCRIPT_SIGNALS, WORKFLOW_SIGNAL } from "./contracts.ts";
// SCRIPT_SIGNAL: only the retired STOP-block criterion in buildBlockSchemas used it.
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

// One entry per block the walk can stop at: a prompt block's answer.
export function buildBlockSchemas(config: StepConfig, projectRoot: string): BlockSchema[] {
    const blockSchemas: BlockSchema[] = [];
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            if (!entry.producesPrompt) {
                continue;
            }
            const templateText = readFileSync(resolve(projectRoot, entry.template), "utf8");
            const template = JSON.parse(templateText) as BlockTemplate;
            if (template.agentAnswer === undefined) {
                throw new Error(`${entry.template} declares no agentAnswer, and ${entry.box} is marked producesPrompt`);
            }
            blockSchemas.push({
                diagram,
                box: entry.box,
                name: getBlockSchemaName(entry.box),
                schema: getSchemaFromTemplate(template.agentAnswer),
            });
        }
    }
    return blockSchemas;
}

// A prompt block stops the walk; its arrows are skipped, ending the list there.
export function buildNextStepsByStep(config: StepConfig): Record<string, string[]> {
    const nextStepsByStep: Record<string, string[]> = {};
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            if (entry.producesPrompt) {
                nextStepsByStep[getStepKey(entry.box, diagram)] = [];
                continue;
            }
            nextStepsByStep[getStepKey(entry.box, diagram)] = entry.next.map(target => getStepKey(target, diagram));
        }
    }
    return nextStepsByStep;
}

// A block script picks its branch, so a walk can reach any block through any arrow, including prompt blocks.
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
            // packet: { type: "object" }, // retired: the hook now returns packetFile instead.
            packetFile: { type: "string" },
            // schema: { type: ["object", "null"] }, // retired: the agent never echoes a schema.
        },
        required: ["box", "scriptSignal", "workflowSignal", "next", "payload", "packetFile"],
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

// The schema an agent answers with: every payload the run could still produce, a list that only shrinks.
export function buildAgentSchema(config: StepConfig, projectRoot: string, startStepKey: string): Record<string, unknown> {
    const reachableSteps = getStepsReachableFrom(startStepKey, buildNextStepsByStep(config));
    const blockSchemas = buildBlockSchemas(config, projectRoot);
    const payloadSchemas: Record<string, unknown>[] = [];
    // Many blocks share one shape, and anyOf only needs each shape once.
    const seenPayloadSchemaTexts = new Set<string>();
    for (const stepKey of reachableSteps) {
        for (const blockSchema of blockSchemas) {
            if (`${blockSchema.diagram}::${blockSchema.box}` === stepKey) {
                const payloadSchemaText = JSON.stringify(blockSchema.schema);
                if (!seenPayloadSchemaTexts.has(payloadSchemaText)) {
                    seenPayloadSchemaTexts.add(payloadSchemaText);
                    payloadSchemas.push(blockSchema.schema);
                }
            }
        }
    }
    // A pass that ends before a prompt block, or at a STOP block, answers payload with {}.
    payloadSchemas.push({ type: "object", maxProperties: 0 });
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
