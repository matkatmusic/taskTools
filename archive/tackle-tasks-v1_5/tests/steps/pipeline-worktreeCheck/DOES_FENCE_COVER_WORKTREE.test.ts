// Behavioral checks for scripts/steps/pipeline-worktreeCheck/DOES_FENCE_COVER_WORKTREE.ts, ported
// from tests/checkTaskFileFence.test.ts's inside/violation shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/DOES_FENCE_COVER_WORKTREE.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

function packet(taskNumber: number, worktree: string, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_PREVIOUS_RUN_RESUMABLE", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot,
        worktree, branch: `task-${taskNumber}`, docsMode: "", exitType: "", exitNote: "",
    });
}

test("test_DOES_FENCE_COVER_WORKTREE_choosesInitSubmodulesRecursivelyWhenEditsStayInsideDeclaredFiles", () => {
    const rootOrigin = makeCommittedRepo("DOES_FENCE_COVER_WORKTREE-");
    const groupId = 900_401;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: ["seed.txt"] }]);
    writeFileSync(join(worktreePath, "seed.txt"), "edited\n");

    const output = main(packet(groupId, worktreePath, rootOrigin));

    assert.equal(output.next, "INIT_SUBMODULES_RECURSIVELY");
    assert.equal(output.docsMode, "UPDATE");
    assert.equal(output.exitType, "");
});

test("test_DOES_FENCE_COVER_WORKTREE_choosesFailuresExitWhenAnEditTouchesAnUndeclaredFile", () => {
    const rootOrigin = makeCommittedRepo("DOES_FENCE_COVER_WORKTREE-");
    const groupId = 900_402;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: ["seed.txt"] }]);
    writeFileSync(join(worktreePath, "outside.txt"), "not owned\n");
    git(worktreePath, "add", "outside.txt");

    const output = main(packet(groupId, worktreePath, rootOrigin));

    assert.equal(output.next, "FAILURES_EXIT");
    assert.equal(output.exitType, "fence-violation");
    assert.match(output.exitNote, /outside\.txt/);
});
