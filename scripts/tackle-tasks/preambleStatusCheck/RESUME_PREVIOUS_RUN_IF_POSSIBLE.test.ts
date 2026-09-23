// Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE adopts the lease, or routes to FAILURES_EXIT when a live run holds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./RESUME_PREVIOUS_RUN_IF_POSSIBLE.ts";
import { claimTask, endTaskRun, updateCurrentTaskRun } from "../shared/taskRunState.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "RESUME_PREVIOUS_RUN_IF_POSSIBLE-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify([{ taskNumber: 1, title: "t1", files: [] }], null, 2)}\n`);
    return root;
}

function packetFields(worktree: string, runId: string, projectRoot: string) {
    return {
        box: "Q_IS_WORKTREE_SAFE_TO_USE_Q", scriptSignal: "continue", taskNumber: 1, runId, projectRoot,
        worktree, branch: "task-1", docsMode: "", planFile: "", exitType: "", exitNote: "",
    };
}

test("test_Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE_routesToFailuresExitWhenALiveRunOwnsTheLease", () => {
    const root = makeProjectRoot();
    const worktree = mkdtempSync(join(tmpdir(), "RESUME_PREVIOUS_RUN_IF_POSSIBLE-worktree-"));
    claimTask(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree, leaseRunId: "run-old" }, root);
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);
    writeFileSync(`${worktree}.lease`, JSON.stringify({ runId: "run-live", pid: 1, createdAt: 1 }));
    const packet = packetFields(worktree, "run-new", root);

    const output = main(JSON.stringify({ ...packet, next: "Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE" }));

    assert.deepEqual(output, {
        ...packet,
        box: "Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE",
        scriptSignal: "continue",
        exitType: "already-running",
        exitNote: "this task is already running through the pipeline",
        next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
    });
});

test("test_Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE_continuesToPreviousRunLeftNotesWhenTheLeaseIsEstablished", () => {
    const root = makeProjectRoot();
    const worktree = mkdtempSync(join(tmpdir(), "RESUME_PREVIOUS_RUN_IF_POSSIBLE-worktree-"));
    claimTask(1, "run-new", root);
    updateCurrentTaskRun(1, "run-new", { worktree }, root);

    const output = main(JSON.stringify({ ...packetFields(worktree, "run-new", root), next: "Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE" }));

    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.box, "Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE");
    assert.equal(output.next, "Q_PREVIOUS_RUN_LEFT_NOTES");
});
