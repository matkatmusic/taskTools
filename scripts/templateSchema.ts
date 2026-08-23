// The envelope owns these, so a block's payload is whatever its output declares beyond them.
const ENVELOPE_OWNED_KEYS = ["box", "signal", "next"];

export function getPayloadFromOutput(output: unknown): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
        if (!ENVELOPE_OWNED_KEYS.includes(key)) {
            payload[key] = value;
        }
    }
    return payload;
}

// Turns a template's example object into a JSON Schema, so an agent's StructuredOutput cannot drift from the template.

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
