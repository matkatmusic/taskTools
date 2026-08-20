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

// Every key the template names must be present with the same kind of value. Extra keys are allowed, so a
// block may add detail without every template that mentions it having to change.
export function getTemplateShapeMismatches(template: unknown, actual: unknown, path = ""): string[] {
    const templateKind = getValueKind(template);
    const actualKind = getValueKind(actual);
    const where = path || "the value";

    if (templateKind !== actualKind) {
        return [`${where} should be ${templateKind}, got ${actualKind}`];
    }

    if (isPlainObject(template) && isPlainObject(actual)) {
        const mismatches: string[] = [];
        for (const [key, templateValue] of Object.entries(template)) {
            if (!(key in actual)) {
                mismatches.push(`${path ? `${path}.` : ""}${key} is missing`);
                continue;
            }
            mismatches.push(...getTemplateShapeMismatches(templateValue, actual[key], `${path ? `${path}.` : ""}${key}`));
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
