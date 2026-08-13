// Behavioral checks for scripts/tackle-tasks/writeTaskExitNotes.ts.
// Run: node --test tests/tackle-tasks/writeTaskExitNotes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTaskExitNotes } from "../../scripts/tackle-tasks/writeTaskExitNotes.ts";
import { readTaskRunState, type TaskRunRecord } from "../../scripts/tackle-tasks/taskRunState.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/writeTaskExitNotes.ts", import.meta.url));

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "writeTaskExitNotes-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function endedRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-old", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:05:00-07:00",
        exitType: "completed", exitNote: "done", modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

test("test_writeTaskExitNotes_exitsNonZeroOnAnUnknownExitType", () => {
    // Scenario: an active run, but the caller passes an exit type outside the thirteen-member union.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [endedRunRecord({ endedAt: null, exitType: null, exitNote: null })] },
    }]);

    // Running the CLI must fail loudly rather than silently write a bogus exit type.
    assert.throws(() => execFileSync("node", [cliPath], {
        input: JSON.stringify({ taskNumber: 1, projectRoot: root, exitType: "not-a-real-exit-type", exitNote: "x" }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
    }));
});

test("test_writeTaskExitNotes_reopensAnAlreadyEndedRunWhenReopenIsSet", () => {
    // Scenario: a run already ended completed (the success tail, per rule 10 case 4), then a
    // later script in the same tail fails operationally and the exit chain must reopen it.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord()] },
    }]);

    // reopen:true routes to replaceEndedRunOutcome, not updateCurrentTaskRun.
    const output = writeTaskExitNotes({
        taskNumber: 1, projectRoot: root, exitType: "run-failed", exitNote: "a later box failed", reopen: true,
    });

    assert.deepEqual(output, { exitType: "run-failed", exitNote: "a later box failed" });
    const state = readTaskRunState(1, root);
    assert.equal(state.active, false);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].exitType, "run-failed");
    assert.equal(state.history[0].exitNote, "a later box failed");
});
