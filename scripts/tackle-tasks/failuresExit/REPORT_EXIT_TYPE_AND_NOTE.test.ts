// Behavioral checks for REPORT_EXIT_TYPE_AND_NOTE.ts. Run: node --test scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./REPORT_EXIT_TYPE_AND_NOTE.ts";
import { claimTask, readTaskRunState, writeTailCursor } from "../shared/taskRunState.ts";

function makeProjectRootWithClaimedTask(taskNumber: number, runId: string): string {
    const root = mkdtempSync(join(tmpdir(), "reportExitTypeAndNote-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber, title: "t" }]));
    claimTask(taskNumber, runId, root);
    return root;
}

test("test_REPORT_EXIT_TYPE_AND_NOTE_reportsTheRunsExitTypeAndNote", () => {
    const projectRoot = makeProjectRootWithClaimedTask(169, "run-a");
    const packet = {
        taskNumber: 169, runId: "run-a", projectRoot, worktree: `${projectRoot}/.worktrees/task-169`,
        branch: "task-169", exitType: "partially-published", exitNote: "boom",
        publicationState: "SOME LANDED", modifiedFiles: [], next: "REPORT_EXIT_TYPE_AND_NOTE",
        leaseReleased: true, leaseRetained: false,
        lockReleased: true, active: false, endedAt: "2026-08-23T12:00:00-07:00",
    };

    const output = main(JSON.stringify(packet));

    assert.equal(output.box, "REPORT_EXIT_TYPE_AND_NOTE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.exitType, "partially-published");
    assert.equal(output.exitNote, "boom");
});

test("test_REPORT_EXIT_TYPE_AND_NOTE_clearsTheTailCursor", () => {
    // Setup: a claimed task with a tail cursor left over from an earlier box in the chain.
    const projectRoot = makeProjectRootWithClaimedTask(170, "run-b");
    writeTailCursor(170, "run-b", { block: "pipeline-failuresExit.mmd::RELEASE_SOURCE_LOCK", input: "{}" }, projectRoot);
    const packet = {
        taskNumber: 170, runId: "run-b", projectRoot, worktree: `${projectRoot}/.worktrees/task-170`,
        branch: "task-170", exitType: "tests-red", exitNote: "n",
        publicationState: "NONE LANDED", modifiedFiles: [], next: "REPORT_EXIT_TYPE_AND_NOTE",
        leaseReleased: true, leaseRetained: false,
        lockReleased: true, active: false, endedAt: "2026-08-23T12:00:00-07:00",
    };

    // Test action: run this, the chain's terminal box.
    main(JSON.stringify(packet));

    // Verification: the tail cursor is gone, so a future resume of this task never lands back in the tail.
    assert.equal(readTaskRunState(170, projectRoot).history[0].tailCursor, null);
});
