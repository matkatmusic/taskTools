// Behavioral checks for scripts/steps/pipeline-failuresExit/DOES_RUN_HOLD_SOURCE_LOCK.ts.  Run: node --test tests/steps/pipeline-failuresExit/DOES_RUN_HOLD_SOURCE_LOCK.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-failuresExit/DOES_RUN_HOLD_SOURCE_LOCK.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";

function packet(projectRoot: string, taskNumber: number, runId: string) {
    return JSON.stringify({
        box: "RELEASE_WORKTREE_LEASE", scriptSignal: "continue", next: "DOES_RUN_HOLD_SOURCE_LOCK",
        taskNumber, runId, projectRoot, worktree: join(projectRoot, "worktree-1"), sourceBranch: "master",
        exitType: "run-failed", exitNote: "boom", publicationState: "NONE LANDED", modifiedFiles: [],
        active: false, endedAt: "2026-08-01T00:00:00-07:00", leaseReleased: false, leaseRetained: false,
    });
}

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "doesRunHoldSourceLock-"));
    return root;
}

test("test_DOES_RUN_HOLD_SOURCE_LOCK_choosesReleaseWhenThisRunOwnsTheLock", () => {
    const root = makeProjectRoot();
    acquireSourceRepoLock(root, buildLockOwner("run-a", 1));

    const output = main(packet(root, 1, "run-a"));

    assert.equal(output.next, "RELEASE_SOURCE_LOCK");
    assert.equal(output.lockReleased, false);
});

test("test_DOES_RUN_HOLD_SOURCE_LOCK_choosesReportExitWhenNoLockIsHeld", () => {
    const root = makeProjectRoot();

    const output = main(packet(root, 1, "run-a"));

    assert.equal(output.next, "REPORT_EXIT_TYPE_AND_NOTE");
});

test("test_DOES_RUN_HOLD_SOURCE_LOCK_choosesReportExitWhenAnotherRunOwnsTheLock", () => {
    const root = makeProjectRoot();
    acquireSourceRepoLock(root, buildLockOwner("run-other", 1));

    const output = main(packet(root, 1, "run-a"));

    assert.equal(output.next, "REPORT_EXIT_TYPE_AND_NOTE");
});
