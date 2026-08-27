// CREATE_WORKTREE.ts is "create a worktree" in pipeline-preambleStatusCheck.mmd. Mutating: exercised only against temp git repos.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./CREATE_WORKTREE.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { git, addSubmodule, makeCommittedRepo } from "../../../tests/support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_CREATE_WORKTREE_createsARealWorktreeOnTheTasksBranchWithSubmodulesPopulated", () => {
    const submoduleOrigin = makeCommittedRepo("CREATE_WORKTREE-sub-");
    const root = makeCommittedRepo("CREATE_WORKTREE-root-");
    addSubmodule(root, submoduleOrigin, "vendor");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);

    const output = main(JSON.stringify({
        box: "DOES_WORKTREE_EXIST_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-a", projectRoot: root,
        worktree: "", branch: taskBranchName(1), docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "CREATE_WORKTREE",
    }));

    assert.ok(existsSync(output.worktree));
    assert.equal(git(output.worktree, "branch", "--show-current"), "task-1");
    assert.ok(existsSync(join(output.worktree, "vendor", "seed.txt")));
    assert.equal(output.docsMode, "");
});
