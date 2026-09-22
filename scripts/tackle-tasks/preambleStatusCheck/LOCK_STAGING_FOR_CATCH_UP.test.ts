// The B_LOCK_STAGING_FOR_CATCH_UP box runs inside run-step, so it tries once and never waits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./LOCK_STAGING_FOR_CATCH_UP.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";

const LOCK_WAIT_STARTED_AT = "2024-01-01T00:00:00.000Z";

const projectRootWithGit = (): string => {
    const root = mkdtempSync(join(tmpdir(), "LOCK_STAGING_FOR_CATCH_UP-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
};

const BASE_INPUT = { taskNumber: 1, worktree: "/wt", branch: "task-1", docsMode: "", planFile: "", exitType: "", exitNote: "" };

test("test_lockStagingForCatchUp_takesTheLockWhenNobodyHoldsIt", () => {
    // Setup: a repo whose lock is free.
    const projectRoot = projectRootWithGit();

    // Test action: ask for the lock.
    const result = main(JSON.stringify({
        ...BASE_INPUT, runId: "run-a", projectRoot, lockWaitStartedAt: LOCK_WAIT_STARTED_AT,
    }));

    // Verification: it is held by this run, and the wait clock is kept.
    assert.equal(result.box, "B_LOCK_STAGING_FOR_CATCH_UP");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.acquired, true);
    assert.equal(result.heldByOwner, "");
    assert.equal(result.lockWaitStartedAt, LOCK_WAIT_STARTED_AT);
});

test("test_lockStagingForCatchUp_returnsAtOnceWhenAnotherRunHoldsTheLock", () => {
    // Setup: another run already owns the lock, and its heartbeat is fresh.
    const projectRoot = projectRootWithGit();
    const rival = buildLockOwner("run-rival", 9);
    assert.equal(acquireSourceRepoLock(projectRoot, rival).status, "acquired");

    // Test action: ask for the lock, timing how long the answer takes.
    const startedAt = Date.now();
    const result = main(JSON.stringify({ ...BASE_INPUT, runId: "run-a", projectRoot, lockWaitStartedAt: LOCK_WAIT_STARTED_AT }));
    const elapsedMs = Date.now() - startedAt;

    // Verification: it reports the holder instead of polling, so a hook's budget survives.
    assert.equal(result.acquired, false);
    assert.equal(result.heldByOwner, rival);
    assert.ok(elapsedMs < 1_000, `waited ${elapsedMs}ms instead of answering at once`);
});

test("test_lockStagingForCatchUp_stampsTheWaitClockOnceOnFirstEntry", () => {
    // Setup: fresh entry from Q_PREFLIGHT_OK_Q, no lockWaitStartedAt yet.
    const projectRoot = projectRootWithGit();

    // Test action: ask for the lock without a wait clock.
    const before = Date.now();
    const result = main(JSON.stringify({ ...BASE_INPUT, runId: "run-a", projectRoot }));

    // Verification: it stamps the clock to now.
    assert.ok(Date.parse(result.lockWaitStartedAt) >= before);
});

test("test_lockStagingForCatchUp_rejectsARelativeProjectRoot", () => {
    // Test action and verification: a relative projectRoot throws.
    assert.throws(() => main(JSON.stringify({ ...BASE_INPUT, runId: "run-a", projectRoot: "relative/path", lockWaitStartedAt: LOCK_WAIT_STARTED_AT })), /projectRoot must be an absolute path/);
});
