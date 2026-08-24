// Behavioral checks for scripts/steps/pipeline-worktreeCheck/IS_PREVIOUS_RUN_RESUMABLE.ts, ported
// from tests/isTaskRunResumable.test.ts. Mutating: it establishes lease ownership as a side effect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/IS_PREVIOUS_RUN_RESUMABLE.ts";
import { claimTask, endTaskRun, updateCurrentTaskRun } from "../../../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "IS_PREVIOUS_RUN_RESUMABLE-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function packet(taskNumber: number, worktree: string, runId: string, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_WORKTREE_SAFE_TO_USE", scriptSignal: "continue", taskNumber, runId, projectRoot,
        worktree, branch: `task-${taskNumber}`, docsMode: "", exitType: "", exitNote: "",
    });
}

test("test_IS_PREVIOUS_RUN_RESUMABLE_choosesDoesFenceCoverWorktreeWhenTheEndedRunLeftContainedNotes", () => {
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "IS_PREVIOUS_RUN_RESUMABLE-worktree-"));
    claimTask(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree, leaseRunId: "run-old" }, root);
    writeFileSync(join(worktree, "notes.md"), "stopped here\n");
    updateCurrentTaskRun(1, "run-old", { implementationNotesFile: "notes.md" }, root);
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);

    const output = main(packet(1, worktree, "run-new", root));

    assert.equal(output.next, "DOES_FENCE_COVER_WORKTREE");
    assert.equal(output.exitType, "");
});

test("test_IS_PREVIOUS_RUN_RESUMABLE_choosesFailuresExitWhenNoEndedRunRecordedAStoppingPoint", () => {
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "IS_PREVIOUS_RUN_RESUMABLE-worktree-"));
    mkdirSync(worktree, { recursive: true });
    claimTask(1, "run-only", root);
    updateCurrentTaskRun(1, "run-only", { worktree, leaseRunId: "run-only" }, root);

    const output = main(packet(1, worktree, "run-only", root));

    assert.equal(output.next, "FAILURES_EXIT");
    assert.equal(output.exitType, "not-resumable");
    assert.equal(output.exitNote, "a safe worktree holds work no run recorded a stopping point for");
});
