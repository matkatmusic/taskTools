import assert from "node:assert/strict";
import { test } from "node:test";
import { getSchemaFromTemplate } from "../scripts/buildRunStepSchemas.ts";
import { getTemplateShapeMismatches } from "../scripts/templateShape.ts";

test("test_getSchemaFromTemplate_closesTheKeySetAndRequiresEveryKey", () => {
    assert.deepEqual(getSchemaFromTemplate({ box: "A", files: 0 }), {
        type: "object",
        properties: { box: { type: "string" }, files: { type: "number" } },
        required: ["box", "files"],
        additionalProperties: false,
    });
});

test("test_getSchemaFromTemplate_describesANestedObject", () => {
    const schema = getSchemaFromTemplate({ task: { number: 0 } }) as Record<string, Record<string, unknown>>;
    assert.deepEqual(schema.properties!.task, {
        type: "object",
        properties: { number: { type: "number" } },
        required: ["number"],
        additionalProperties: false,
    });
});

test("test_getSchemaFromTemplate_takesArrayItemsFromTheFirstExample", () => {
    assert.deepEqual(getSchemaFromTemplate(["name"]), { type: "array", items: { type: "string" } });
});

test("test_getSchemaFromTemplate_leavesAnEmptyArrayOpen", () => {
    assert.deepEqual(getSchemaFromTemplate([]), { type: "array" });
});

test("test_getSchemaFromTemplate_tellsNullApartFromAnObject", () => {
    assert.deepEqual(getSchemaFromTemplate(null), { type: "null" });
});

test("test_getSchemaFromTemplate_describesABoolean", () => {
    assert.deepEqual(getSchemaFromTemplate(true), { type: "boolean" });
});

// The schema and the shape checker read the same template, so they must agree on what the template allows.
test("test_getSchemaFromTemplate_requiresExactlyTheKeysTemplateShapeRequires", () => {
    const template = { box: "A", signal: "continue", files: 0 };
    const schema = getSchemaFromTemplate(template) as { required: string[]; additionalProperties: boolean };
    assert.deepEqual(schema.required, Object.keys(template));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(getTemplateShapeMismatches(template, { box: "B", signal: "stop", files: 1 }), []);
});
