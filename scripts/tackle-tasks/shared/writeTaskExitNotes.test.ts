// Behavioral checks for scripts/tackle-tasks/writeTaskExitNotes.ts.
// Run: node --test tests/writeTaskExitNotes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTaskExitNotes } from "./writeTaskExitNotes.ts";
import { readTaskRunState, type TaskRunRecord } from "./taskRunState.ts";

const cliPath = fileURLToPath(new URL("./writeTaskExitNotes.ts", import.meta.url));

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
        input: JSON.stringify({ taskNumber: 1, runId: "run-old", projectRoot: root, exitType: "not-a-real-exit-type", exitNote: "x" }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
    }));
});

test("test_writeTaskExitNotes_acceptsNotResumable", () => {
    // Scenario: IS_PREVIOUS_RUN_RESUMABLE_Q exits "not-resumable"; the writer must record it, not throw.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [endedRunRecord({ endedAt: null, exitType: null, exitNote: null })] },
    }]);

    const output = writeTaskExitNotes({ taskNumber: 1, runId: "run-old", projectRoot: root, exitType: "not-resumable", exitNote: "no stopping point" });

    assert.deepEqual(output, { exitType: "not-resumable", exitNote: "no stopping point" });
    assert.equal(readTaskRunState(1, root).history[0].exitType, "not-resumable");
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
        taskNumber: 1, runId: "run-old", projectRoot: root, exitType: "run-failed", exitNote: "a later box failed", reopen: true,
    });

    assert.deepEqual(output, { exitType: "run-failed", exitNote: "a later box failed" });
    const state = readTaskRunState(1, root);
    assert.equal(state.active, false);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].exitType, "run-failed");
    assert.equal(state.history[0].exitNote, "a later box failed");
});

test("test_writeTaskExitNotes_throwsWithASiblingRunId", () => {
    // Scenario (F6): a process pauses, its run ends, a new run is claimed. The paused process
    // finally writes exit notes — it must fence against the newer run, not silently retarget it.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-new", endedAt: null, exitType: null, exitNote: null })] },
    }]);

    assert.throws(() => writeTaskExitNotes({
        taskNumber: 1, runId: "run-old-paused", projectRoot: root, exitType: "run-failed", exitNote: "stale write",
    }));

    const state = readTaskRunState(1, root);
    assert.equal(state.history[0].exitType, null);
});
