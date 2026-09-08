// IS_PREVIOUS_RUN_RESUMABLE_Q.ts is "is the previous run's work resumable?" in pipeline-preambleStatusCheck.mmd. Mutating: adopts lease ownership.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/IS_PREVIOUS_RUN_RESUMABLE_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./IS_PREVIOUS_RUN_RESUMABLE_Q.ts";
import { claimTask, endTaskRun, readTaskRunState, updateCurrentTaskRun } from "../shared/taskRunState.ts";

function makeProjectRoot(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "IS_PREVIOUS_RUN_RESUMABLE_Q-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function packet(taskNumber: number, worktree: string, runId: string, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_WORKTREE_SAFE_TO_USE_Q", scriptSignal: "continue", taskNumber, runId, projectRoot,
        worktree, branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "IS_PREVIOUS_RUN_RESUMABLE_Q",
    });
}

test("test_IS_PREVIOUS_RUN_RESUMABLE_Q_choosesRebaseResumedWorktreeWhenTheEndedRunLeftContainedNotes", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "IS_PREVIOUS_RUN_RESUMABLE_Q-worktree-"));
    claimTask(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree, leaseRunId: "run-old" }, root);
    writeFileSync(join(worktree, "notes.md"), "stopped here\n");
    updateCurrentTaskRun(1, "run-old", { implementationNotesFile: "notes.md" }, root);
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);

    const output = main(packet(1, worktree, "run-new", root));

    assert.equal(output.next, "REBASE_RESUMED_WORKTREE_ONTO_STAGING");
    assert.equal(output.exitType, "");
});

test("test_IS_PREVIOUS_RUN_RESUMABLE_Q_choosesFailuresExitWhenNoEndedRunRecordedAStoppingPoint", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "IS_PREVIOUS_RUN_RESUMABLE_Q-worktree-"));
    mkdirSync(worktree, { recursive: true });
    claimTask(1, "run-only", root);
    updateCurrentTaskRun(1, "run-only", { worktree, leaseRunId: "run-only" }, root);

    const output = main(packet(1, worktree, "run-only", root));

    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "not-resumable");
    assert.equal(output.exitNote, "a safe worktree holds work no run recorded a stopping point for");
});

test("test_IS_PREVIOUS_RUN_RESUMABLE_Q_runsTwiceWithTheSameInput", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t1", files: [] }]);
    const worktree = mkdtempSync(join(tmpdir(), "IS_PREVIOUS_RUN_RESUMABLE_Q-worktree-"));
    claimTask(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree, leaseRunId: "run-old" }, root);
    writeFileSync(join(worktree, "notes.md"), "stopped here\n");
    updateCurrentTaskRun(1, "run-old", { implementationNotesFile: "notes.md" }, root);
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);
    const input = packet(1, worktree, "run-new", root);
    const leasePath = `${worktree}.lease`;

    const firstOutput = main(input);
    const firstState = readTaskRunState(1, root);
    const firstLease = existsSync(leasePath) ? readFileSync(leasePath, "utf8") : null;
    const secondOutput = main(input);
    const secondState = readTaskRunState(1, root);
    const secondLease = existsSync(leasePath) ? readFileSync(leasePath, "utf8") : null;

    assert.deepEqual(secondOutput, firstOutput);
    assert.deepEqual(secondState, firstState);
    assert.equal(secondLease, firstLease);
});
