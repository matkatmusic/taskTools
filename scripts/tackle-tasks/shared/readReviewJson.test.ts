// Behavioral checks for scripts/tackle-tasks/shared/readReviewJson.ts. Run: node --test scripts/tackle-tasks/shared/readReviewJson.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewJson } from "./readReviewJson.ts";

function writeTempFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "read-review-json-"));
    const file = join(dir, "review.json");
    writeFileSync(file, content);
    return file;
}

test("test_readReviewJson_parsesBareJson", () => {
    // The file holds plain JSON with no markdown fence around it.
    const file = writeTempFile("{\"outcome\":\"OK\"}");
    assert.deepEqual(readReviewJson(file), { outcome: "OK" });
});

test("test_readReviewJson_parsesJsonInsideAJsonCodeFence", () => {
    // The file wraps the JSON in a ```json ... ``` fence, as codex sometimes writes it.
    const file = writeTempFile("```json\n{\"outcome\":\"OK\"}\n```\n");
    assert.deepEqual(readReviewJson(file), { outcome: "OK" });
});

test("test_readReviewJson_parsesJsonInsideABareCodeFence", () => {
    // The file wraps the JSON in a bare ``` ... ``` fence, with no language tag.
    const file = writeTempFile("```\n{\"outcome\":\"OK\"}\n```\n");
    assert.deepEqual(readReviewJson(file), { outcome: "OK" });
});

test("test_readReviewJson_throwsOnTextThatIsNotJson", () => {
    // Text that is not JSON, and not fenced JSON either, still throws.
    const file = writeTempFile("not json at all");
    assert.throws(() => readReviewJson(file), SyntaxError);
});

test("test_readReviewJson_throwsNamingThePathWhenTheFileIsEmpty", () => {
    const file = writeTempFile("");
    assert.throws(() => readReviewJson(file), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
