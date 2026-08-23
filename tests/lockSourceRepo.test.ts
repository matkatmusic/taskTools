// The LOCK_SOURCE_REPO box runs inside a hook, so it tries once and never waits.
// Run: node --test tests/lockSourceRepo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockSourceRepo } from "../scripts/tackle-tasks/lockSourceRepo.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../scripts/tackle-tasks/sourceRepoLock.ts";

const projectRootWithGit = (): string => {
    const root = mkdtempSync(join(tmpdir(), "lockSourceRepo-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
};

test("test_lockSourceRepo_takesTheLockWhenNobodyHoldsIt", async () => {
    // Setup: a repo whose lock is free.
    const projectRoot = projectRootWithGit();

    // Test action: ask for the lock.
    const result = await lockSourceRepo({ taskNumber: 1, runId: "run-a", projectRoot });

    // Verification: it is held by this run.
    assert.deepEqual(result, { acquired: true, heldByOwner: null });
});

test("test_lockSourceRepo_returnsAtOnceWhenAnotherRunHoldsTheLock", async () => {
    // Setup: another run already owns the lock, and its heartbeat is fresh.
    const projectRoot = projectRootWithGit();
    const rival = buildLockOwner("run-rival", 9);
    assert.equal(acquireSourceRepoLock(projectRoot, rival).status, "acquired");

    // Test action: ask for the lock, timing how long the answer takes.
    const startedAt = Date.now();
    const result = await lockSourceRepo({ taskNumber: 1, runId: "run-a", projectRoot });
    const elapsedMs = Date.now() - startedAt;

    // Verification: it reports the holder instead of polling, so a hook's budget survives.
    assert.equal(result.acquired, false);
    assert.equal(result.heldByOwner, rival);
    assert.ok(elapsedMs < 1_000, `waited ${elapsedMs}ms instead of answering at once`);
});
