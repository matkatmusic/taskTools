// claimTaskRun.ts is "claim the task" in pipeline.mmd.
// Run alone: node --test tests/tackle-tasks/claimTaskRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimTaskRun } from "../../scripts/tackle-tasks/claimTaskRun.ts";
import { readTaskRunState } from "../../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRoot(openTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "claimTaskRun-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
    return root;
}

test("test_claimTaskRun_claimsAnUnclaimedTaskAndActivatesItInTasksJson", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const output = claimTaskRun(1, "run-a", root);
    assert.deepEqual(output, { status: "claimed", heldByRunId: null });
    assert.equal(readTaskRunState(1, root).active, true);
});

test("test_claimTaskRun_refusesATaskAlreadyClaimedByAnotherRun", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    claimTaskRun(1, "run-a", root);
    const output = claimTaskRun(1, "run-b", root);
    assert.deepEqual(output, { status: "refused", heldByRunId: "run-a" });
});

test("test_claimTaskRun_reportsNotFoundForATaskAbsentFromTasksJson", () => {
    const root = makeProjectRoot([]);
    const output = claimTaskRun(999, "run-a", root);
    assert.deepEqual(output, { status: "not-found", heldByRunId: null });
});
