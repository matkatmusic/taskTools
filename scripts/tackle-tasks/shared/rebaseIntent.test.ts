// Behavioral checks for rebaseIntent.ts's durable stash of a rebase-then-resume detour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRebaseIntent, readRetainedRebaseIntent, writeRebaseIntent } from "./rebaseIntent.ts";

function makeWorktreePath(): string {
    return join(mkdtempSync(join(tmpdir(), "rebase-intent-")), "task-1");
}

test("test_rebaseIntent_readsBackWhatWasWritten", () => {
    const worktreePath = makeWorktreePath();
    const intent = { taskNumber: 1, runId: "run-1", targetBlock: "pipeline-x.mmd::Y", targetInput: "{}" };

    writeRebaseIntent(worktreePath, intent);

    assert.deepEqual(readRetainedRebaseIntent(worktreePath), intent);
});

test("test_rebaseIntent_readsNullWhenNoneIsRetained", () => {
    const worktreePath = makeWorktreePath();

    assert.equal(readRetainedRebaseIntent(worktreePath), null);
});

test("test_rebaseIntent_clearRemovesIt", () => {
    const worktreePath = makeWorktreePath();
    writeRebaseIntent(worktreePath, { taskNumber: 1, runId: "run-1", targetBlock: "pipeline-x.mmd::Y", targetInput: "{}" });

    clearRebaseIntent(worktreePath);

    assert.equal(readRetainedRebaseIntent(worktreePath), null);
});
