// RESET_WORKTREE.ts is "reset the worktree" in pipeline-preambleStatusCheck.mmd. Mutating: temp git repos only.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/RESET_WORKTREE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./RESET_WORKTREE.ts";
import { main as takeLeaseBeforeReset } from "./TAKE_WORKTREE_LEASE_BEFORE_RESET.ts";
import { claimTask, readTaskRunState, updateCurrentTaskRun } from "../shared/taskRunState.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { createFreshTaskWorktree } from "../shared/_createFreshTaskWorktree.ts";
import { git, addSubmodule, makeCommittedRepo } from "../../../tests/support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_RESET_WORKTREE_tearsDownAndRecreatesACleanWorktreeOnTheTaskBranch", () => {
    const submoduleOrigin = makeCommittedRepo("RESET_WORKTREE-sub-");
    const root = makeCommittedRepo("RESET_WORKTREE-root-");
    addSubmodule(root, submoduleOrigin, "vendor");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-old", root);
    const firstWorktree = createFreshTaskWorktree(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree: firstWorktree, leaseRunId: "run-old" }, root);
    writeFileSync(join(firstWorktree, "dirty.txt"), "leaked work\n");

    // The lease is released by TAKE_WORKTREE_LEASE_BEFORE_RESET before RESET_WORKTREE tears the worktree down.
    const beforeReset = takeLeaseBeforeReset(JSON.stringify({
        box: "IS_WORKTREE_SAFE_TO_USE_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-old", projectRoot: root,
        worktree: firstWorktree, branch: taskBranchName(1), docsMode: "", planFile: "", exitType: "", exitNote: "",
    }));

    const output = main(JSON.stringify(beforeReset));

    assert.equal(output.docsMode, "AUTOGEN");
    assert.ok(existsSync(output.worktree));
    assert.ok(!existsSync(join(output.worktree, "dirty.txt")));
    assert.equal(git(output.worktree, "branch", "--show-current"), "task-1");
    assert.equal(readTaskRunState(1, root).worktree, output.worktree);
});

test("test_RESET_WORKTREE_runsTwiceWithTheSameInput", () => {
    const root = makeCommittedRepo("RESET_WORKTREE-root2-");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-old", root);
    const firstWorktree = createFreshTaskWorktree(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree: firstWorktree, leaseRunId: "run-old" }, root);

    const beforeReset = takeLeaseBeforeReset(JSON.stringify({
        box: "IS_WORKTREE_SAFE_TO_USE_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-old", projectRoot: root,
        worktree: firstWorktree, branch: taskBranchName(1), docsMode: "", planFile: "", exitType: "", exitNote: "",
    }));
    const input = JSON.stringify(beforeReset);

    const firstOutput = main(input);
    const firstState = readTaskRunState(1, root);
    const firstLog = git(firstOutput.worktree, "log", "--oneline", "-1");
    const secondOutput = main(input);
    const secondState = readTaskRunState(1, root);
    const secondLog = git(secondOutput.worktree, "log", "--oneline", "-1");

    assert.deepEqual(secondOutput, firstOutput);
    assert.deepEqual(secondState, firstState);
    assert.equal(secondLog, firstLog);
    assert.ok(existsSync(secondOutput.worktree));
});
