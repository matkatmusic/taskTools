import assert from "node:assert/strict";
import { test } from "node:test";
import { whatToReturnSection } from "../scripts/tackle-tasks/shared/whatToReturn.ts";

// value fills the additionalData slot verbatim; explanationOfValue follows the object; the last sentence never varies.
test("test_whatToReturnSection_wrapsTheValueInMessageAndAdditionalDataAndAlwaysSaysToReturnThatShapeAnyway", () => {
    const section = whatToReturnSection('{ "reviewFile": "/tmp/review.json" }', "the path `$REVIEW_FILE` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.");
    assert.equal(section, [
        "## WHAT YOU, THE SPAWNING AGENT, RETURNS",
        "",
        'Return `{ "message": "", "additionalData": { "reviewFile": "/tmp/review.json" } }`, the path `$REVIEW_FILE` was set to, never its contents.',
        "",
        "If the command above could not be run at all, return that same shape anyway. The next block reads the file and fails loudly when it is missing or unusable.",
    ].join("\n"));
});
