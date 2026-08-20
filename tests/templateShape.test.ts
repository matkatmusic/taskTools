import assert from "node:assert/strict";
import { test } from "node:test";
import { getTemplateShapeMismatches } from "../scripts/templateShape.ts";

test("test_getTemplateShapeMismatches_findsNothingWhenTheShapesMatch", () => {
    assert.deepEqual(getTemplateShapeMismatches({ box: "A", signal: "continue" }, { box: "B", signal: "stop" }), []);
});

test("test_getTemplateShapeMismatches_namesAMissingKey", () => {
    assert.deepEqual(getTemplateShapeMismatches({ box: "A", signal: "continue" }, { box: "B" }), ["signal is missing"]);
});

test("test_getTemplateShapeMismatches_namesAKeyOfTheWrongKind", () => {
    assert.deepEqual(getTemplateShapeMismatches({ files: 0 }, { files: "twelve" }), ["files should be number, got string"]);
});

test("test_getTemplateShapeMismatches_namesAKeyTheTemplateDoesNotHave", () => {
    assert.deepEqual(getTemplateShapeMismatches({ box: "A" }, { box: "B", extra: 1 }), ["extra is not in the template"]);
});

test("test_getTemplateShapeMismatches_namesAnUnexpectedKeyInsideANestedObject", () => {
    const mismatches = getTemplateShapeMismatches({ task: { number: 0 } }, { task: { number: 1, name: "x" } });
    assert.deepEqual(mismatches, ["task.name is not in the template"]);
});

test("test_getTemplateShapeMismatches_looksInsideANestedObject", () => {
    const mismatches = getTemplateShapeMismatches({ task: { number: 0 } }, { task: { number: "one" } });
    assert.deepEqual(mismatches, ["task.number should be number, got string"]);
});

test("test_getTemplateShapeMismatches_checksEveryItemAgainstTheFirstTemplateItem", () => {
    const mismatches = getTemplateShapeMismatches({ files: ["name"] }, { files: ["a", 2] });
    assert.deepEqual(mismatches, ["files[1] should be string, got number"]);
});

test("test_getTemplateShapeMismatches_acceptsAnyItemsWhenTheTemplateArrayIsEmpty", () => {
    assert.deepEqual(getTemplateShapeMismatches({ files: [] }, { files: ["a", 2] }), []);
});

test("test_getTemplateShapeMismatches_tellsNullApartFromAnObject", () => {
    assert.deepEqual(getTemplateShapeMismatches({ result: {} }, { result: null }), ["result should be object, got null"]);
});

test("test_getTemplateShapeMismatches_allowsNoKeysWhenTheTemplateObjectIsEmpty", () => {
    assert.deepEqual(getTemplateShapeMismatches({}, { anything: 1 }), ["anything is not in the template"]);
});
