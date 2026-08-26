// Behavioral checks for scripts/steps/pipeline-failuresExit/DOES_RUN_HOLD_LEASE.ts.  Run: node --test tests/steps/pipeline-failuresExit/DOES_RUN_HOLD_LEASE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-failuresExit/DOES_RUN_HOLD_LEASE.ts";

function packet(worktree: string, runId: string) {
    return JSON.stringify({
        box: "MARK_TASK_INACTIVE_FAILURE", scriptSignal: "continue", taskNumber: 1, runId,
        projectRoot: "/repo", worktree, sourceBranch: "master", exitType: "run-failed", exitNote: "boom",
        publicationState: "NONE LANDED", modifiedFiles: [], active: false, endedAt: "2026-08-01T00:00:00-07:00",
    });
}

test("test_DOES_RUN_HOLD_LEASE_choosesReleaseWhenThisRunOwnsTheLease", () => {
    const root = mkdtempSync(join(tmpdir(), "doesRunHoldLease-"));
    const worktreePath = join(root, "worktree-1");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-a", pid: 1, createdAt: 0 }));

    const output = main(packet(worktreePath, "run-a"));

    assert.equal(output.next, "RELEASE_WORKTREE_LEASE");
    assert.equal(output.leaseReleased, false);
    assert.equal(output.leaseRetained, false);
});

test("test_DOES_RUN_HOLD_LEASE_choosesSourceLockCheckWhenNoLeaseExists", () => {
    const root = mkdtempSync(join(tmpdir(), "doesRunHoldLease-"));
    const worktreePath = join(root, "worktree-1");

    const output = main(packet(worktreePath, "run-a"));

    assert.equal(output.next, "DOES_RUN_HOLD_SOURCE_LOCK");
});

test("test_DOES_RUN_HOLD_LEASE_choosesSourceLockCheckWhenAnotherRunOwnsTheLease", () => {
    const root = mkdtempSync(join(tmpdir(), "doesRunHoldLease-"));
    const worktreePath = join(root, "worktree-1");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-other", pid: 1, createdAt: 0 }));

    const output = main(packet(worktreePath, "run-a"));

    assert.equal(output.next, "DOES_RUN_HOLD_SOURCE_LOCK");
});
