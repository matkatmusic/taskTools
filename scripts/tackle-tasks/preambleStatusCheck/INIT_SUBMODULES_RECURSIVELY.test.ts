// INIT_SUBMODULES_RECURSIVELY.ts is "init submodules recursively" in pipeline-preambleStatusCheck.mmd. Mutating: exercised only against temp git repos.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/INIT_SUBMODULES_RECURSIVELY.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./INIT_SUBMODULES_RECURSIVELY.ts";
import { claimTask, readTaskRunState } from "../shared/taskRunState.ts";
import { makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_INIT_SUBMODULES_RECURSIVELY_isANoOpAfterCreateWorktreeForGroupAlreadyPopulatedThem", () => {
    // Setup: createWorktreeForGroup (via makeLinkedWorktree) already populates submodules.
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_301;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: [] }]);
    claimTask(groupId, "run-a", rootOrigin);

    const output = main(JSON.stringify({
        box: "DOES_FENCE_COVER_WORKTREE_Q", scriptSignal: "continue", taskNumber: groupId, runId: "run-a",
        projectRoot: rootOrigin, worktree: worktreePath, branch: `task-${groupId}`, docsMode: "UPDATE",
        planFile: "", exitType: "", exitNote: "", next: "INIT_SUBMODULES_RECURSIVELY",
    }));

    assert.equal(output.box, "INIT_SUBMODULES_RECURSIVELY");
    assert.ok(existsSync(join(worktreePath, "child", "seed.txt")));
    assert.ok(existsSync(join(worktreePath, "child", "grandchild", "seed.txt")));
});

test("test_INIT_SUBMODULES_RECURSIVELY_runsTwiceWithTheSameInput", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_302;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: [] }]);
    claimTask(groupId, "run-a", rootOrigin);
    const input = JSON.stringify({
        box: "DOES_FENCE_COVER_WORKTREE_Q", scriptSignal: "continue", taskNumber: groupId, runId: "run-a",
        projectRoot: rootOrigin, worktree: worktreePath, branch: `task-${groupId}`, docsMode: "UPDATE",
        planFile: "", exitType: "", exitNote: "", next: "INIT_SUBMODULES_RECURSIVELY",
    });

    const firstOutput = main(input);
    const firstState = readTaskRunState(groupId, rootOrigin);
    const secondOutput = main(input);
    const secondState = readTaskRunState(groupId, rootOrigin);

    assert.deepEqual(secondOutput, firstOutput);
    assert.deepEqual(secondState, firstState);
});
