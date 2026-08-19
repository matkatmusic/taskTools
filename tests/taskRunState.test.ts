// Behavioral checks for taskRunState.ts's persisted attempt counters.  Run alone: node --test tests/taskRunState.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    claimTask,
    getAttemptCount,
    raiseAttemptCount,
    MAX_ATTEMPTS,
} from "../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-attempts-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

test("test_getAttemptCount_returnsZeroWhenNeverRaised", () => {
    // Setup: a task with an active run that has no attempts field at all.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: read a counter that has never been raised.
    const count = getAttemptCount(1, "clarifyRounds", root);
    // Verification: it reads as zero.
    assert.equal(count, 0);
});

test("test_raiseAttemptCount_incrementsAndReturnsTheNewValue", () => {
    // Setup: a task with an active run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raise the same counter twice.
    const first = raiseAttemptCount(1, "run-a", "testFixes", root);
    const second = raiseAttemptCount(1, "run-a", "testFixes", root);
    // Verification: each call returns the counter's new value.
    assert.equal(first, 1);
    assert.equal(second, 2);
});

test("test_raiseAttemptCount_persistsToTasksJson", () => {
    // Setup: a task with an active run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raise a counter, then read it back through getAttemptCount.
    raiseAttemptCount(1, "run-a", "mergeAttempts", root);
    const count = getAttemptCount(1, "mergeAttempts", root);
    // Verification: the raise was written to disk, not just returned in memory.
    assert.equal(count, 1);
});

test("test_raiseAttemptCount_tracksEachCounterNameIndependently", () => {
    // Setup: a task with an active run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raise one counter three times and a different counter once.
    raiseAttemptCount(1, "run-a", "conflictFixes", root);
    raiseAttemptCount(1, "run-a", "conflictFixes", root);
    raiseAttemptCount(1, "run-a", "conflictFixes", root);
    raiseAttemptCount(1, "run-a", "reviews", root);
    // Verification: the two counters hold separate values.
    assert.equal(getAttemptCount(1, "conflictFixes", root), 3);
    assert.equal(getAttemptCount(1, "reviews", root), 1);
});

test("test_raiseAttemptCount_throwsWhenExpectedRunIdIsNotTheNewestRun", () => {
    // Setup: a task with an active run under a different runId.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raising with a stale runId throws.
    assert.throws(() => raiseAttemptCount(1, "run-stale", "testFixes", root));
});

test("test_MAX_ATTEMPTS_isTwo", () => {
    // Verification: the pipeline's retry cap is two.
    assert.equal(MAX_ATTEMPTS, 2);
});
