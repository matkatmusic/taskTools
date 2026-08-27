// The one schema every run-step agent answers with. The hook and the workflow generator share it.

// A bare name belongs to the diagram that wrote it; a name holding :: already points across a seam.
export function getStepKey(target: string, diagram: string): string {
    return target.includes("::") ? target : `${diagram}::${target}`;
}

// The object the hook always returns. payload is the path of the packet file, never the packet itself.
export function buildHookOutputSchema(): Record<string, unknown> {
    const outcome = {
        type: "object",
        properties: {
            next: { type: ["string", "null"] },
            payload: { type: "string" },
        },
        required: ["next", "payload"],
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
