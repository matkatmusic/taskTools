import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./ARE_2_CLARIFY_ROUNDS_DONE_Q.ts";

// A temp project root holding one task whose run history carries a "clarify" attempt count.
function makeProjectRoot(clarifyAttempts: number): string {
    const root = mkdtempSync(join(tmpdir(), "are-2-clarify-rounds-done-q-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35,
        run: {
            active: true,
            worktree: "/tmp/fake-worktree",
            leaseRunId: "run-1",
            history: [{
                runId: "run-1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
                attempts: { clarify: clarifyAttempts },
            }],
        },
    }]));
    return root;
}

const packet = (projectRoot: string) => JSON.stringify({
    taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", branch: "task-35", projectRoot,
    docsMode: "", planFile: "", exitType: "", exitNote: "", outcome: "CLARIFY", clarifyRequest: "which database?",
});

test("test_ARE_2_CLARIFY_ROUNDS_DONE_Q_isNotDoneUnderTheCap", () => {
    const output = main(packet(makeProjectRoot(0)));
    assert.equal(output.next, "WRITE_CLARIFY_REQUEST");
    assert.equal(output.exitType, "");
});

test("test_ARE_2_CLARIFY_ROUNDS_DONE_Q_isDoneAtTheCap", () => {
    const output = main(packet(makeProjectRoot(2)));
    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "clarify-stuck");
    assert.match(String(output.exitNote), /asked twice/);
});
