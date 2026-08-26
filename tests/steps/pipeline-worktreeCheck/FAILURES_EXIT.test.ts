// Behavioral checks for scripts/steps/pipeline-worktreeCheck/FAILURES_EXIT.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/FAILURES_EXIT.ts";

test("test_FAILURES_EXIT_forwardsTheExitTypeAndNoteUnchanged", () => {
    const output = main(JSON.stringify({
        box: "DOES_FENCE_COVER_WORKTREE", scriptSignal: "continue", taskNumber: 1, runId: "run-1",
        projectRoot: "/tmp/example-project", worktree: "/tmp/example-project-worktrees/task-1", branch: "task-1",
        docsMode: "", exitType: "fence-violation", exitNote: "the resumed worktree touched files the task does not own: some/path.ts",
    }));

    assert.deepEqual(output, {
        box: "FAILURES_EXIT",
        scriptSignal: "continue",
        taskNumber: 1,
        runId: "run-1",
        projectRoot: "/tmp/example-project",
        worktree: "/tmp/example-project-worktrees/task-1",
        sourceBranch: "task-1",
        exitType: "fence-violation",
        exitNote: "the resumed worktree touched files the task does not own: some/path.ts",
    });
});
