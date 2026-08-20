// Compares a value against a template object, so a block's input and output can be checked without a schema library.

function getValueKind(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return getValueKind(value) === "object";
}

// The template is the source of truth: the key sets must be equal, and every value must be the same kind.
export function getTemplateShapeMismatches(template: unknown, actual: unknown, path = ""): string[] {
    const templateKind = getValueKind(template);
    const actualKind = getValueKind(actual);
    const where = path || "the value";

    if (templateKind !== actualKind) {
        return [`${where} should be ${templateKind}, got ${actualKind}`];
    }

    if (isPlainObject(template) && isPlainObject(actual)) {
        const prefix = path ? `${path}.` : "";
        const mismatches: string[] = [];
        for (const [key, templateValue] of Object.entries(template)) {
            if (!(key in actual)) {
                mismatches.push(`${prefix}${key} is missing`);
                continue;
            }
            mismatches.push(...getTemplateShapeMismatches(templateValue, actual[key], `${prefix}${key}`));
        }
        for (const key of Object.keys(actual)) {
            if (!(key in template)) {
                mismatches.push(`${prefix}${key} is not in the template`);
            }
        }
        return mismatches;
    }

    if (Array.isArray(template) && Array.isArray(actual)) {
        const firstTemplateItem = template[0];
        if (firstTemplateItem === undefined) {
            return [];
        }
        const mismatches: string[] = [];
        for (const [index, actualItem] of actual.entries()) {
            mismatches.push(...getTemplateShapeMismatches(firstTemplateItem, actualItem, `${where}[${index}]`));
        }
        return mismatches;
    }

    return [];
}
