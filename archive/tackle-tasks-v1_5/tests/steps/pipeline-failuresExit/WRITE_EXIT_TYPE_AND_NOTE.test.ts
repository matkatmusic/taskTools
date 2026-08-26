// Behavioral checks for scripts/steps/pipeline-failuresExit/WRITE_EXIT_TYPE_AND_NOTE.ts.  Run: node --test tests/steps/pipeline-failuresExit/WRITE_EXIT_TYPE_AND_NOTE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-failuresExit/WRITE_EXIT_TYPE_AND_NOTE.ts";
import { readTaskRunState } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-failuresExit/WRITE_EXIT_TYPE_AND_NOTE.template.json");

function makeProjectRootWithActiveRun(): string {
    const root = mkdtempSync(join(tmpdir(), "writeExitTypeAndNote-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: null, leaseRunId: null,
            history: [{
                runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
                exitType: null, exitNote: null, modifiedFiles: [], commits: [],
                implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }], null, 2));
    return root;
}

test("test_WRITE_EXIT_TYPE_AND_NOTE_writesTheIncomingExitTypeAndNoteAsIs", () => {
    const root = makeProjectRootWithActiveRun();
    const packet = JSON.stringify({
        box: "DID_ANY_WORK_LAND", scriptSignal: "continue", next: "WRITE_EXIT_TYPE_AND_NOTE",
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: join(root, "worktree"),
        sourceBranch: "master", exitType: "run-failed", exitNote: "a script failed operationally",
        publicationState: "NONE LANDED",
    });

    const output = main(packet);

    assert.equal(output.exitType, "run-failed");
    assert.equal(output.exitNote, "a script failed operationally");
    const state = readTaskRunState(1, root);
    assert.equal(state.history[0].exitType, "run-failed");
    assert.equal(state.history[0].exitNote, "a script failed operationally");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
