// DOES_WORKTREE_EXIST_Q.ts is "does a worktree exist?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/DOES_WORKTREE_EXIST_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./DOES_WORKTREE_EXIST_Q.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../shared/prepareTasks.ts";

function makeProjectRoot(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "DOES_WORKTREE_EXIST_Q-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(tasks));
    return root;
}

function packet(projectRoot: string): string {
    return JSON.stringify({
        box: "MARK_TASK_ACTIVE", scriptSignal: "continue", taskNumber: 1, runId: "run-1", projectRoot,
        worktree: "", branch: "task-1", docsMode: "", planFile: "", exitType: "", exitNote: "",
    });
}

test("test_DOES_WORKTREE_EXIST_Q_choosesCreateWorktreeWhenTheConventionalPathIsAbsent", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    const output = main(packet(root));
    assert.equal(output.next, "CREATE_WORKTREE");
    assert.equal(output.worktree, "");
});

test("test_DOES_WORKTREE_EXIST_Q_choosesIsWorktreeSafeToUseWhenTheConventionalPathIsOnDisk", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    mkdirSync(worktree, { recursive: true });
    const output = main(packet(root));
    assert.equal(output.next, "IS_WORKTREE_SAFE_TO_USE_Q");
    assert.equal(output.worktree, worktree);
});
