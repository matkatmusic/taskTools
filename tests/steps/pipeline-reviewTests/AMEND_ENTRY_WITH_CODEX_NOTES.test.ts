// Behavioral checks for scripts/steps/pipeline-reviewTests/AMEND_ENTRY_WITH_CODEX_NOTES.ts. Mutating: uses a fresh temp project root, never real task state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-reviewTests/AMEND_ENTRY_WITH_CODEX_NOTES.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-reviewTests/AMEND_ENTRY_WITH_CODEX_NOTES.template.json");

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "amend-codex-notes-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([
        { taskNumber: 99, files: ["src/thing.ts"], codexReviewNotes: "" },
    ]));
    return root;
}

function packetFor(projectRoot: string, notes: string) {
    return {
        box: "ARE_2_TEST_REVIEWS_DONE", scriptSignal: "continue", next: "AMEND_ENTRY_WITH_CODEX_NOTES",
        projectRoot, taskNumber: 99, worktreePath: `${projectRoot}/worktree`, sourceBranch: "main", runId: "run-1",
        notes, exitType: "", exitNote: "",
    };
}

const entryOf = (root: string) => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"))[0];

test("test_main_writesTheReviewerNotesIntoTheTaskEntry", () => {
    const projectRoot = makeProjectRoot();
    const output = main(JSON.stringify(packetFor(projectRoot, "SENTINEL_PROBLEM\n\nFix: SENTINEL_FIX")));
    assert.equal(output.amended, true);
    assert.equal(output.box, "AMEND_ENTRY_WITH_CODEX_NOTES");
    assert.match(entryOf(projectRoot).codexReviewNotes, /SENTINEL_PROBLEM/);
    assert.match(entryOf(projectRoot).codexReviewNotes, /SENTINEL_FIX/);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_main_throwsWhenThereAreNoNotesToWrite", () => {
    const projectRoot = makeProjectRoot();
    assert.throws(() => main(JSON.stringify(packetFor(projectRoot, ""))), /no reviewer notes to write/);
});
