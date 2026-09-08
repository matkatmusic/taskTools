// IS_TASK_ACTIVE_Q.ts is "is the task active?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/IS_TASK_ACTIVE_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./IS_TASK_ACTIVE_Q.ts";
import { claimTask } from "../shared/taskRunState.ts";

function packet(taskNumber: number, projectRoot: string): string {
    return JSON.stringify({
        box: "IS_TASK_BLOCKED_Q", scriptSignal: "continue", taskNumber, runId: "", projectRoot,
        worktree: "", branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "IS_TASK_ACTIVE_Q",
    });
}

function makeProjectRoot(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "IS_TASK_ACTIVE_Q-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(tasks));
    return root;
}

test("test_IS_TASK_ACTIVE_Q_continuesToMarkTaskActiveWhenNotActive", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const output = main(packet(1, root));
    assert.equal(output.next, "PREFLIGHT_OK_Q");
    assert.equal(output.exitType, "");
});

test("test_IS_TASK_ACTIVE_Q_exitsWhenAPreviousRunLeftTheTaskActive", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    claimTask(1, "run-a", root);
    const output = main(packet(1, root));
    assert.equal(output.next, "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT");
    assert.equal(output.exitType, "already-active");
    assert.equal(output.exitNote, "a previous run left the task active");
});
