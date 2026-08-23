// The single source of truth for every run-step payload shape.
import { getTemplateShapeMismatches } from "./templateShape.ts";

// scriptSignal: printed by a block script, read by the hook.
export const SCRIPT_SIGNAL = {
    CONTINUE: "continue",
    STOP: "stop",
    PROMPT: "prompt",
} as const;

export type ScriptSignal = typeof SCRIPT_SIGNAL[keyof typeof SCRIPT_SIGNAL];

export const KNOWN_SCRIPT_SIGNALS: ScriptSignal[] = [SCRIPT_SIGNAL.CONTINUE, SCRIPT_SIGNAL.STOP, SCRIPT_SIGNAL.PROMPT];

// workflowSignal: set by the hook in its outcome, read by the workflow loop.
export const WORKFLOW_SIGNAL = {
    CONTINUE: "continue",
    DONE: "done",
} as const;

export type WorkflowSignal = typeof WORKFLOW_SIGNAL[keyof typeof WORKFLOW_SIGNAL];

// What every returns_a_prompt block prints. Only box varies.
export function buildPromptOutputTemplate(box: string): Record<string, unknown> {
    return { box, scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: "" };
}

// The one shape every agent answer takes, for every returns_a_prompt block.
export const AGENT_ANSWER_TEMPLATE = { message: "", additionalData: {} } as const;

// Throws with every mismatch named, so a bad payload fails loudly at the boundary it crossed.
export function assertMatchesTemplate(blockName: string, template: unknown, actual: unknown): void {
    const mismatches = getTemplateShapeMismatches(template, actual);
    if (mismatches.length > 0) {
        throw new Error(`${blockName} payload does not match its contract: ${mismatches.join("; ")}`);
    }
}
