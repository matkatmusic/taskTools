// TAKE_WORKTREE_LEASE_BEFORE_RESET.ts is "take the worktree lease" (before reset) in pipeline-preambleStatusCheck.mmd. Mutating: temp files only.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/TAKE_WORKTREE_LEASE_BEFORE_RESET.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./TAKE_WORKTREE_LEASE_BEFORE_RESET.ts";
import { claimTask, readTaskRunState, updateCurrentTaskRun } from "../shared/taskRunState.ts";

function makeProjectRoot(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "TAKE_WORKTREE_LEASE_BEFORE_RESET-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function packet(taskNumber: number, runId: string, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_WORKTREE_SAFE_TO_USE_Q", scriptSignal: "continue", taskNumber, runId, projectRoot,
        worktree: "", branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "TAKE_WORKTREE_LEASE_BEFORE_RESET",
    });
}

test("test_TAKE_WORKTREE_LEASE_BEFORE_RESET_passesThroughUnchangedWhenNoWorktreeIsRecorded", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);
    const output = main(packet(1, "run-a", root));
    assert.equal(output.box, "TAKE_WORKTREE_LEASE_BEFORE_RESET");
    assert.equal(readTaskRunState(1, root).worktree, null);
});

test("test_TAKE_WORKTREE_LEASE_BEFORE_RESET_refusesWhenTheSiblingLeaseNamesAnotherOwner", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "TAKE_WORKTREE_LEASE_BEFORE_RESET-worktree-"));
    claimTask(1, "run-a", root);
    updateCurrentTaskRun(1, "run-a", { worktree, leaseRunId: "run-a" }, root);
    writeFileSync(`${worktree}.lease`, JSON.stringify({ runId: "run-b", pid: 1, createdAt: 1 }));
    assert.throws(() => main(packet(1, "run-a", root)), /held by run "run-b", refusing reset/);
});

test("test_TAKE_WORKTREE_LEASE_BEFORE_RESET_runsTwiceWithTheSameInput", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "TAKE_WORKTREE_LEASE_BEFORE_RESET-worktree-"));
    claimTask(1, "run-a", root);
    updateCurrentTaskRun(1, "run-a", { worktree, leaseRunId: "run-a" }, root);
    writeFileSync(`${worktree}.lease`, JSON.stringify({ runId: "run-a", pid: 1, createdAt: 1 }));
    const input = packet(1, "run-a", root);

    const firstOutput = main(input);
    const firstState = readTaskRunState(1, root);
    const secondOutput = main(input);
    const secondState = readTaskRunState(1, root);

    assert.deepEqual(secondOutput, firstOutput);
    assert.deepEqual(secondState, firstState);
});
