// DOES_FENCE_COVER_WORKTREE_Q.ts is "does the task's file list cover what the worktree touched?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/DOES_FENCE_COVER_WORKTREE_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./DOES_FENCE_COVER_WORKTREE_Q.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

function packet(taskNumber: number, worktree: string, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_PREVIOUS_RUN_RESUMABLE_Q", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot,
        worktree, branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "DOES_FENCE_COVER_WORKTREE_Q",
    });
}

test("test_DOES_FENCE_COVER_WORKTREE_Q_choosesInitSubmodulesRecursivelyAndSetsDocsModeUpdateWhenEditsStayInsideDeclaredFiles", () => {
    const rootOrigin = makeCommittedRepo("DOES_FENCE_COVER_WORKTREE_Q-");
    const groupId = 900_401;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: ["seed.txt"] }]);
    writeFileSync(join(worktreePath, "seed.txt"), "edited\n");

    const output = main(packet(groupId, worktreePath, rootOrigin));

    assert.equal(output.next, "INIT_SUBMODULES_RECURSIVELY");
    assert.equal(output.docsMode, "UPDATE");
    assert.equal(output.exitType, "");
});

test("test_DOES_FENCE_COVER_WORKTREE_Q_ignoresTheResumedRunsOwnCheckpointFile", () => {
    const rootOrigin = makeCommittedRepo("DOES_FENCE_COVER_WORKTREE_Q-");
    const groupId = 900_403;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: ["seed.txt"] }]);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "checkpoint.json"), "{}\n");
    git(worktreePath, "add", "plans/checkpoint.json");

    const output = main(packet(groupId, worktreePath, rootOrigin));

    assert.equal(output.next, "INIT_SUBMODULES_RECURSIVELY");
    assert.equal(output.exitType, "");
});

test("test_DOES_FENCE_COVER_WORKTREE_Q_choosesFailuresExitWhenAnEditTouchesAnUndeclaredFile", () => {
    const rootOrigin = makeCommittedRepo("DOES_FENCE_COVER_WORKTREE_Q-");
    const groupId = 900_402;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: ["seed.txt"] }]);
    writeFileSync(join(worktreePath, "outside.txt"), "not owned\n");
    git(worktreePath, "add", "outside.txt");

    const output = main(packet(groupId, worktreePath, rootOrigin));

    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "fence-violation");
    assert.match(String(output.exitNote), /outside\.txt/);
});
