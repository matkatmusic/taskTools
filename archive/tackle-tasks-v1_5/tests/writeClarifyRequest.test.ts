// Behavioral checks for scripts/tackle-tasks/writeClarifyRequest.ts. Run: node --test tests/writeClarifyRequest.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClarifyRequest } from "../scripts/tackle-tasks/writeClarifyRequest.ts";

// A project root holding one open task, which is all this box needs.
function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "write-clarify-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, files: ["src/owned.ts"], codexReviewNotes: "",
    }]));
    return root;
}

const entryOf = (root: string) => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"))[0];

test("test_writeClarifyRequest_writesTheRequestWhereTheNextPlannerReadsIt", () => {
    const root = makeProjectRoot();

    const output = writeClarifyRequest({ projectRoot: root, taskNumber: 35, clarifyRequest: "SENTINEL_WHICH_DATABASE" });

    assert.equal(output.written, true);
    assert.equal(entryOf(root).clarifyRequest, "SENTINEL_WHICH_DATABASE");
});

test("test_writeClarifyRequest_leavesTheCodexReviewNotesChannelAlone", () => {
    const root = makeProjectRoot();

    writeClarifyRequest({ projectRoot: root, taskNumber: 35, clarifyRequest: "SENTINEL_WHICH_DATABASE" });

    assert.equal(entryOf(root).codexReviewNotes, "");
});

test("test_writeClarifyRequest_throwsOnAnEmptyRequest", () => {
    assert.throws(
        () => writeClarifyRequest({ projectRoot: makeProjectRoot(), taskNumber: 35, clarifyRequest: "   " }),
        /sent an empty request/,
    );
});

test("test_writeClarifyRequest_throwsWhenTheTaskIsNotInTasksJson", () => {
    assert.throws(
        () => writeClarifyRequest({ projectRoot: makeProjectRoot(), taskNumber: 999, clarifyRequest: "anything" }),
        /task 999 not found/,
    );
});
