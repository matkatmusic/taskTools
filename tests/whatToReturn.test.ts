import assert from "node:assert/strict";
import { test } from "node:test";
import { whatToReturnSection } from "../scripts/tackle-tasks/shared/whatToReturn.ts";

// value fills the additionalData slot verbatim; explanationOfValue follows the object; the last sentence never varies.
test("test_whatToReturnSection_wrapsTheValueInMessageAndAdditionalDataAndAlwaysSaysToReturnThatShapeAnyway", () => {
    const section = whatToReturnSection('{ "reviewFile": "/tmp/review.json" }', "the path `$REVIEW_FILE` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.");
    assert.equal(section, [
        "## WHAT YOU, THE SPAWNING AGENT, RETURNS",
        "",
        "Do these three steps in order.",
        '1. Build `{ "message": "", "additionalData": { "reviewFile": "/tmp/review.json" } }`, the path `$REVIEW_FILE` was set to, never its contents.',
        "2. Write that object into the packet file named by `outcome.payload` in the hook output, the same file this prompt came from, next to the keys already there. Change no key you did not add.",
        "3. Only after step 2 is done, return the hook output verbatim.",
        "",
        "If the command above could not be run at all, write that same shape anyway. The next block reads the file and fails loudly when it is missing or unusable.",
    ].join("\n"));
});
