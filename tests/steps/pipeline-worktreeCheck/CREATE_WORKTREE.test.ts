// Behavioral checks for scripts/steps/pipeline-worktreeCheck/CREATE_WORKTREE.ts, ported from
// tests/createTaskWorktree.test.ts. Mutating: exercised only against temp git repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/CREATE_WORKTREE.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { taskBranchName } from "../../../scripts/tackle-tasks/createTaskWorktree.ts";
import { git, makeCommittedRepo, addSubmodule } from "../../support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_CREATE_WORKTREE_createsARealWorktreeOnTheTasksBranchWithSubmodulesPopulated", () => {
    // Setup: a real repo with a real submodule, and an active claimed run for task 1.
    const submoduleOrigin = makeCommittedRepo("CREATE_WORKTREE-sub-");
    const root = makeCommittedRepo("CREATE_WORKTREE-root-");
    addSubmodule(root, submoduleOrigin, "vendor");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);

    // Test action: create the task worktree.
    const output = main(JSON.stringify({
        box: "DOES_WORKTREE_EXIST", scriptSignal: "continue", taskNumber: 1, runId: "run-a",
        projectRoot: root, worktree: "", branch: taskBranchName(1), docsMode: "", exitType: "", exitNote: "",
    }));

    // Verification: a real linked worktree exists, on the task's branch, submodule populated.
    assert.equal(output.docsMode, "AUTOGEN");
    assert.ok(existsSync(output.worktree));
    const currentBranch = git(output.worktree, "branch", "--show-current");
    assert.equal(currentBranch, "task-1");
    assert.ok(existsSync(join(output.worktree, "vendor", "seed.txt")));
});
