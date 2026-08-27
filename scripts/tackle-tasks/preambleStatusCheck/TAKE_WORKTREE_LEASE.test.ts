// TAKE_WORKTREE_LEASE.ts is "take the worktree lease" in pipeline-preambleStatusCheck.mmd. Mutating: temp git repos only.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/TAKE_WORKTREE_LEASE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./TAKE_WORKTREE_LEASE.ts";
import { claimTask, readTaskRunState } from "../shared/taskRunState.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { makeCommittedRepo } from "../../../tests/support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_TAKE_WORKTREE_LEASE_recordsTheWorktreePathAndLeaseRunIdAndSetsDocsModeAutogen", () => {
    const root = makeCommittedRepo("TAKE_WORKTREE_LEASE-");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);
    const worktree = join(root, "..", "task-1-worktree");

    const output = main(JSON.stringify({
        box: "CREATE_WORKTREE", scriptSignal: "continue", taskNumber: 1, runId: "run-a", projectRoot: root,
        worktree, branch: taskBranchName(1), docsMode: "", planFile: "", exitType: "", exitNote: "",
    }));

    assert.equal(output.box, "TAKE_WORKTREE_LEASE");
    assert.equal(output.docsMode, "AUTOGEN");
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, worktree);
    assert.equal(state.leaseRunId, "run-a");
});
