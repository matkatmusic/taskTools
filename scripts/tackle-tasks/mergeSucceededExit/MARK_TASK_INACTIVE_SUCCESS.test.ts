// Behavioral checks for MARK_TASK_INACTIVE_SUCCESS.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./MARK_TASK_INACTIVE_SUCCESS.ts";
import { readTaskRunState, type TaskRunRecord } from "../shared/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "MARK_TASK_INACTIVE_SUCCESS.template.json");

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "mark-task-inactive-success-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function activeRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
        exitType: "completed", exitNote: "merged", modifiedFiles: ["a.ts"],
        commits: [{ occurrenceId: "", hash: "abc123", kind: "merge" }],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

function samplePacket(projectRoot: string, taskNumber: number, runId: string, closureNote: string): Record<string, unknown> {
    return { box: "BUILD_CLOSURE_NOTE", scriptSignal: "continue", projectRoot, taskNumber, runId, closureNote };
}

test("test_MARK_TASK_INACTIVE_SUCCESS_endsTheRunAndCarriesTheClosureNoteForward", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord()] },
    }]);

    const output = main(JSON.stringify(samplePacket(root, 1, "run-a", "Task 1 completed.")));

    assert.equal(output.box, "MARK_TASK_INACTIVE_SUCCESS");
    assert.equal(output.closureNote, "Task 1 completed.");
    const state = readTaskRunState(1, root);
    assert.equal(state.active, false);
    assert.equal(state.history[0].exitType, "completed");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_MARK_TASK_INACTIVE_SUCCESS_runsTwiceWithTheSameInput", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord()] },
    }]);
    const input = JSON.stringify(samplePacket(root, 1, "run-a", "Task 1 completed."));

    const first = main(input);
    const stateAfterFirst = readTaskRunState(1, root);
    const second = main(input);
    const stateAfterSecond = readTaskRunState(1, root);

    assert.deepEqual(second, first);
    assert.deepEqual(stateAfterSecond, stateAfterFirst);
});

test("test_MARK_TASK_INACTIVE_SUCCESS_throwsWithASiblingRunId", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord({ runId: "run-new" })] },
    }]);

    assert.throws(() => main(JSON.stringify(samplePacket(root, 1, "run-old", "note"))));

    const state = readTaskRunState(1, root);
    assert.equal(state.active, true);
});
