// Behavioral checks for scripts/tackle-tasks/shared/readJsonFile.ts. Run: node --test scripts/tackle-tasks/shared/readJsonFile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "./readJsonFile.ts";

function tempPath(): string {
    return join(mkdtempSync(join(tmpdir(), "read-json-file-")), "state.json");
}

test("test_readJsonFile_returnsParsedContent", () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ a: 1 }));
    assert.deepEqual(readJsonFile(path), { a: 1 });
});

test("test_readJsonFile_throwsNamingThePathWhenTheFileIsEmpty", () => {
    const path = tempPath();
    writeFileSync(path, "");
    assert.throws(() => readJsonFile(path), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("test_readJsonFile_throwsWhenTheFileIsMissing", () => {
    const path = tempPath();
    assert.throws(() => readJsonFile(path), /ENOENT/);
});

test("test_readJsonFile_doesNotNameThePathForNonEmptyMalformedContent", () => {
    const path = tempPath();
    writeFileSync(path, "{\"a\":");
    assert.throws(() => readJsonFile(path), (error: unknown) => {
        assert.ok(error instanceof SyntaxError);
        assert.equal((error as Error).message.includes(path), false);
        return true;
    });
});
