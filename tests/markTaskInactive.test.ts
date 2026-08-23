// Behavioral checks for scripts/tackle-tasks/markTaskInactive.ts.
// Run: node --test tests/markTaskInactive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markTaskInactive } from "../scripts/tackle-tasks/markTaskInactive.ts";
import { readTaskRunState, type TaskRunRecord } from "../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "markTaskInactive-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function activeRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
        exitType: "completed", exitNote: "merged", modifiedFiles: ["a.ts"],
        commits: [{ occurrenceId: "", hash: "abc123", kind: "merge" }],
        implementationNotesFile: "plans/notes-1.md", taskTests: null, fullSuite: null,
        ...overrides,
    };
}

test("test_markTaskInactive_leavesTheExitNotesAndModifiedFilesInPlace", () => {
    // Scenario: an active run that already has exit notes and modified files recorded.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord()] },
    }]);

    // Marking it inactive stamps endedAt and flips active, and touches nothing else.
    const output = markTaskInactive({ taskNumber: 1, runId: "run-a", projectRoot: root });

    assert.equal(output.active, false);
    assert.match(output.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const state = readTaskRunState(1, root);
    assert.equal(state.active, false);
    const record = state.history[0];
    assert.equal(record.exitType, "completed");
    assert.equal(record.exitNote, "merged");
    assert.deepEqual(record.modifiedFiles, ["a.ts"]);
    assert.deepEqual(record.commits, [{ occurrenceId: "", hash: "abc123", kind: "merge" }]);
    assert.equal(record.implementationNotesFile, "plans/notes-1.md");
});

test("test_markTaskInactive_throwsWithASiblingRunId", () => {
    // F6: the active run belongs to run-new; a paused run-old process must not end it.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [activeRunRecord({ runId: "run-new" })] },
    }]);

    assert.throws(() => markTaskInactive({ taskNumber: 1, runId: "run-old", projectRoot: root }));

    const state = readTaskRunState(1, root);
    assert.equal(state.active, true);
});
