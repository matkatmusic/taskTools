// Behavioral checks for scripts/steps/pipeline-failuresExit/MARK_TASK_INACTIVE_FAILURE.ts.  Ported from tests/markTaskInactive.test.ts. Run: node --test tests/steps/pipeline-failuresExit/MARK_TASK_INACTIVE_FAILURE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-failuresExit/MARK_TASK_INACTIVE_FAILURE.ts";
import { readTaskRunState } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-failuresExit/MARK_TASK_INACTIVE_FAILURE.template.json");

function makeProjectRootWithActiveRun(): string {
    const root = mkdtempSync(join(tmpdir(), "markTaskInactiveFailure-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: null, leaseRunId: null,
            history: [{
                runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
                exitType: "run-failed", exitNote: "boom", modifiedFiles: ["a.ts"], commits: [],
                implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }], null, 2));
    return root;
}

function packet(projectRoot: string) {
    return JSON.stringify({
        box: "RECORD_MODIFIED_FILES_FAILURE", scriptSignal: "continue",
        taskNumber: 1, runId: "run-a", projectRoot, worktree: join(projectRoot, "worktree"),
        sourceBranch: "master", exitType: "run-failed", exitNote: "boom", publicationState: "NONE LANDED",
        modifiedFiles: ["a.ts"],
    });
}

test("test_MARK_TASK_INACTIVE_FAILURE_marksTheTaskInactiveAndLeavesExitNotesInPlace", () => {
    const root = makeProjectRootWithActiveRun();

    const output = main(packet(root));

    assert.equal(output.active, false);
    assert.match(output.endedAt as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const state = readTaskRunState(1, root);
    assert.equal(state.active, false);
    assert.equal(state.history[0].exitType, "run-failed");
    assert.deepEqual(state.history[0].modifiedFiles, ["a.ts"]);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
