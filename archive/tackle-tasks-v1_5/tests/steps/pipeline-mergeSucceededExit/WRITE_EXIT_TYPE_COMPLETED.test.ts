// Behavioral checks for scripts/steps/pipeline-mergeSucceededExit/WRITE_EXIT_TYPE_COMPLETED.ts.  Ported from tests/writeTaskExitNotes.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-mergeSucceededExit/WRITE_EXIT_TYPE_COMPLETED.ts";
import { readTaskRunState, type TaskRunRecord } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(
    dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-mergeSucceededExit/WRITE_EXIT_TYPE_COMPLETED.template.json",
);

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "write-exit-type-completed-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function activeRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
        exitType: null, exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

function samplePacket(projectRoot: string, taskNumber: number, runId: string, worktreePath: string): Record<string, unknown> {
    return {
        box: "RECORD_MERGE_COMMIT_HASHES", scriptSignal: "continue", projectRoot, taskNumber, runId,
        worktreePath, rootSourceBranch: "main", exitNote: "All layers merged successfully.",
    };
}

test("test_WRITE_EXIT_TYPE_COMPLETED_writesCompletedWithTheGivenExitNote", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord()] },
    }]);

    const output = main(JSON.stringify(samplePacket(root, 1, "run-a", "/tmp/worktree")));

    assert.equal(output.box, "WRITE_EXIT_TYPE_COMPLETED");
    assert.equal(output.scriptSignal, "continue");
    assert.equal("exitNote" in output, false);
    const state = readTaskRunState(1, root);
    assert.equal(state.history[0].exitType, "completed");
    assert.equal(state.history[0].exitNote, "All layers merged successfully.");
});

test("test_WRITE_EXIT_TYPE_COMPLETED_throwsWithASiblingRunId", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord({ runId: "run-new" })] },
    }]);

    assert.throws(() => main(JSON.stringify(samplePacket(root, 1, "run-old", "/tmp/worktree"))));

    const state = readTaskRunState(1, root);
    assert.equal(state.history[0].exitType, null);
});

test("test_WRITE_EXIT_TYPE_COMPLETED_carriesTheRestOfThePacketForward", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord()] },
    }]);

    const output = main(JSON.stringify(samplePacket(root, 1, "run-a", "/tmp/worktree")));

    assert.equal(output.worktreePath, "/tmp/worktree");
    assert.equal(output.rootSourceBranch, "main");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
