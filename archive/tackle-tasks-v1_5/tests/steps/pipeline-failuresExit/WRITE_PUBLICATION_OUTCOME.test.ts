// Behavioral checks for scripts/steps/pipeline-failuresExit/WRITE_PUBLICATION_OUTCOME.ts.  Run: node --test tests/steps/pipeline-failuresExit/WRITE_PUBLICATION_OUTCOME.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-failuresExit/WRITE_PUBLICATION_OUTCOME.ts";
import { readTaskRunState } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-failuresExit/WRITE_PUBLICATION_OUTCOME.template.json");

function makeProjectRootWithActiveRun(exitType: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "writePublicationOutcome-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: null, leaseRunId: null,
            history: [{
                runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
                exitType, exitNote: null, modifiedFiles: [], commits: [],
                implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }], null, 2));
    return root;
}

function packet(projectRoot: string) {
    return JSON.stringify({
        box: "DID_ANY_WORK_LAND", scriptSignal: "continue", next: "WRITE_PUBLICATION_OUTCOME",
        taskNumber: 1, runId: "run-a", projectRoot, worktree: join(projectRoot, "worktree"),
        sourceBranch: "master", exitType: "run-failed", exitNote: "boom", publicationState: "SOME LANDED",
    });
}

test("test_WRITE_PUBLICATION_OUTCOME_writesPartiallyPublishedWhenNotAlreadyCompleted", () => {
    const root = makeProjectRootWithActiveRun(null);

    const output = main(packet(root));

    assert.equal(output.exitType, "partially-published");
    const state = readTaskRunState(1, root);
    assert.equal(state.history[0].exitType, "partially-published");
    assert.equal(state.history[0].cleanupIncomplete, true);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_WRITE_PUBLICATION_OUTCOME_keepsCompletedWhenAlreadyWritten", () => {
    const root = makeProjectRootWithActiveRun("completed");

    const output = main(packet(root));

    assert.equal(output.exitType, "completed");
    const state = readTaskRunState(1, root);
    assert.equal(state.history[0].exitType, "completed");
});
