// Behavioral checks for scripts/tackle-tasks/shared/checkpoint.ts. Run: node --test scripts/tackle-tasks/shared/checkpoint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointPath, readCheckpoint, writeCheckpoint, type Checkpoint } from "./checkpoint.ts";

function tempWorktree(): string {
    return mkdtempSync(join(tmpdir(), "checkpoint-"));
}

const SAMPLE: Checkpoint = {
    taskNumber: 7, passId: "p1", runId: "r1", projectRoot: "/repo",
    block: "one.mmd::A", input: "{}", state: "running", sourceLockHeld: false,
    exitType: "", exitNote: "", resumedFrom: null,
};

test("test_writeCheckpointThenReadCheckpointRoundTrips", () => {
    const worktree = tempWorktree();
    writeCheckpoint(worktree, SAMPLE);
    assert.deepEqual(readCheckpoint(worktree), SAMPLE);
});

test("test_readCheckpoint_throwsNamingThePathWhenTheCheckpointFileIsEmpty", () => {
    const worktree = tempWorktree();
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(checkpointPath(worktree), "");
    assert.throws(() => readCheckpoint(worktree), new RegExp(checkpointPath(worktree).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
