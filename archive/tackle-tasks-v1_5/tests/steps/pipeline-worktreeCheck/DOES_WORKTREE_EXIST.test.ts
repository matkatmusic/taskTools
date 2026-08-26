// Behavioral checks for scripts/steps/pipeline-worktreeCheck/DOES_WORKTREE_EXIST.ts, ported from
// tests/doesTaskWorktreeExist.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/DOES_WORKTREE_EXIST.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../../scripts/prepareTasks.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "DOES_WORKTREE_EXIST-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function packet(projectRoot: string): string {
    return JSON.stringify({
        box: "ACTIVE_TASK_INPUT", scriptSignal: "continue", taskNumber: 1, runId: "run-1",
        projectRoot, worktree: "", branch: "task-1", docsMode: "", exitType: "", exitNote: "",
    });
}

test("test_DOES_WORKTREE_EXIST_choosesCreateWorktreeWhenTheConventionalPathIsAbsent", () => {
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t1", files: [] }]);

    const output = main(packet(root));

    assert.equal(output.next, "CREATE_WORKTREE");
    assert.equal(output.worktree, "");
});

test("test_DOES_WORKTREE_EXIST_choosesIsWorktreeSafeToUseWhenTheConventionalPathIsOnDisk", () => {
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    mkdirSync(worktree, { recursive: true });

    const output = main(packet(root));

    assert.equal(output.next, "IS_WORKTREE_SAFE_TO_USE");
    assert.equal(output.worktree, worktree);
});
