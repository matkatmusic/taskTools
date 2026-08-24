// Behavioral checks for scripts/steps/pipeline-worktreeCheck/TAKE_WORKTREE_LEASE_BEFORE_RESET.ts,
// ported from tests/resetTaskWorktree.test.ts's lease-refusal case. Mutating: temp files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/TAKE_WORKTREE_LEASE_BEFORE_RESET.ts";
import { claimTask, updateCurrentTaskRun, readTaskRunState } from "../../../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "TAKE_WORKTREE_LEASE_BEFORE_RESET-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function packet(taskNumber: number, runId: string, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_WORKTREE_SAFE_TO_USE", scriptSignal: "continue", taskNumber, runId, projectRoot,
        worktree: "", branch: `task-${taskNumber}`, docsMode: "", exitType: "", exitNote: "",
    });
}

test("test_TAKE_WORKTREE_LEASE_BEFORE_RESET_passesThroughUnchangedWhenNoWorktreeIsRecorded", () => {
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);

    const output = main(packet(1, "run-a", root));

    assert.equal(output.box, "TAKE_WORKTREE_LEASE_BEFORE_RESET");
    assert.equal(readTaskRunState(1, root).worktree, null);
});

test("test_TAKE_WORKTREE_LEASE_BEFORE_RESET_refusesWhenTheSiblingLeaseNamesAnotherOwner", () => {
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "TAKE_WORKTREE_LEASE_BEFORE_RESET-worktree-"));
    claimTask(1, "run-a", root);
    updateCurrentTaskRun(1, "run-a", { worktree, leaseRunId: "run-a" }, root);
    writeFileSync(`${worktree}.lease`, JSON.stringify({ runId: "run-b", pid: 1, createdAt: 1 }));

    assert.throws(() => main(packet(1, "run-a", root)), /held by run "run-b", refusing reset/);
});
