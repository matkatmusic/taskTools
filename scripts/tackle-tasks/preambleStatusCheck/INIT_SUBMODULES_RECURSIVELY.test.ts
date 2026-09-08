// INIT_SUBMODULES_RECURSIVELY.ts is "init submodules recursively" in pipeline-preambleStatusCheck.mmd. Mutating: exercised only against temp git repos.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/INIT_SUBMODULES_RECURSIVELY.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", modifiableFiles: [] }]);
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
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", modifiableFiles: [] }]);
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

test("test_INIT_SUBMODULES_RECURSIVELY_continuesWhenAnOwnedFileLivesInsideASubmodule", () => {
    // Setup: a task whose only owned file is inside the child submodule.
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_303;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", modifiableFiles: ["child/seed.txt"] }]);
    claimTask(groupId, "run-a", rootOrigin);
    // Action: run the block.
    const output = main(JSON.stringify({
        box: "DOES_FENCE_COVER_WORKTREE_Q", scriptSignal: "continue", taskNumber: groupId, runId: "run-a",
        projectRoot: rootOrigin, worktree: worktreePath, branch: `task-${groupId}`, docsMode: "UPDATE",
        planFile: "", exitType: "", exitNote: "", next: "INIT_SUBMODULES_RECURSIVELY",
    }));
    // Verification: the submodule file is on disk after init, so the block continues to DOCUMENT_GENERATION.
    assert.equal(output.next, "DOCUMENT_GENERATION");
    assert.equal(output.exitType, "");
});

test("test_INIT_SUBMODULES_RECURSIVELY_routesToFailuresExitWhenAnOwnedFileIsMissingAndNotCreatedByTheTask", () => {
    // Setup: a task naming one file that exists, one the task creates, and one that is missing.
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_304;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", modifiableFiles: ["child/seed.txt", "new.ts", "gone.ts"], createsFiles: ["new.ts"] }]);
    claimTask(groupId, "run-a", rootOrigin);
    // Action: run the block.
    const output = main(JSON.stringify({
        box: "DOES_FENCE_COVER_WORKTREE_Q", scriptSignal: "continue", taskNumber: groupId, runId: "run-a",
        projectRoot: rootOrigin, worktree: worktreePath, branch: `task-${groupId}`, docsMode: "UPDATE",
        planFile: "", exitType: "", exitNote: "", next: "INIT_SUBMODULES_RECURSIVELY",
    }));
    // Verification: only gone.ts is reported; the run goes to FAILURES_EXIT.
    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "owned-file-missing");
    assert.match(output.exitNote, /task 900304: modifiableFiles names gone\.ts but that file is not in the worktree.*"createsFiles"/);
});
