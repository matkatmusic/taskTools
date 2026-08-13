// sourceRepoLock.ts holds one durable, heartbeat-based lock on the source repository
// across many short-lived processes. See plans/diagram/pipeline.mmd rule 9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
    acquireSourceRepoLock,
    buildLockOwner,
    readSourceRepoLock,
    recoverSourceRepoLock,
    refreshSourceRepoLock,
    releaseSourceRepoLock,
} from "../../scripts/tackle-tasks/sourceRepoLock.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-sourceLock-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
}

test("test_buildLockOwner_joinsRunIdAndTaskNumberWithAColon", () => {
    // Step: build an owner token from a runId and a taskNumber.
    const owner = buildLockOwner("run-abc", 169);
    // Step: the token must be "runId:taskNumber", not runId alone.
    assert.equal(owner, "run-abc:169");
});

test("test_acquireSourceRepoLock_blocksASecondTaskInTheSameRunId", () => {
    // Step: two tasks share one runId, so their owner tokens differ only by taskNumber.
    const root = makeProjectRoot();
    const ownerA = buildLockOwner("run-1", 10);
    const ownerB = buildLockOwner("run-1", 11);
    // Step: task A acquires the lock first.
    const firstOutcome = acquireSourceRepoLock(root, ownerA);
    assert.deepEqual(firstOutcome, { status: "acquired" });
    // Step: task B, in the same run, must be blocked rather than treated as the same owner.
    const secondOutcome = acquireSourceRepoLock(root, ownerB);
    assert.equal(secondOutcome.status, "held");
    assert.equal((secondOutcome as { owner: string }).owner, ownerA);
});

test("test_acquireSourceRepoLock_isANoOpForTheSameOwner", () => {
    // Step: one owner acquires the lock.
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-2", 20);
    acquireSourceRepoLock(root, owner);
    // Step: the same owner re-enters the box on a merge retry.
    const outcome = acquireSourceRepoLock(root, owner);
    // Step: re-acquiring the same owner token is a no-op, not a block.
    assert.deepEqual(outcome, { status: "already-held-by-me" });
});

test("test_releaseSourceRepoLock_refusesToReleaseAnotherOwnersLock", () => {
    // Step: owner A holds the lock.
    const root = makeProjectRoot();
    const ownerA = buildLockOwner("run-3", 30);
    const ownerB = buildLockOwner("run-3", 31);
    acquireSourceRepoLock(root, ownerA);
    // Step: owner B, who never held the lock, tries to release it.
    const outcome = releaseSourceRepoLock(root, ownerB);
    // Step: the release must be refused, and the lock must remain in place.
    assert.deepEqual(outcome, { released: false });
    assert.equal(readSourceRepoLock(root)?.owner, ownerA);
});

test("test_releaseSourceRepoLock_removesTheLockWhenTheOwnerMatches", () => {
    // Step: an owner acquires the lock.
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-4", 40);
    acquireSourceRepoLock(root, owner);
    // Step: the same owner releases it.
    const outcome = releaseSourceRepoLock(root, owner);
    // Step: the release succeeds and the lock file is gone.
    assert.deepEqual(outcome, { released: true });
    assert.equal(readSourceRepoLock(root), null);
});

test("test_acquireSourceRepoLock_reportsRecoverableRatherThanStealingAColdLock", () => {
    // Step: an owner acquires the lock at time zero, then the process exits without releasing.
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-5", 50);
    const startMs = Date.parse("2026-01-01T00:00:00.000Z");
    acquireSourceRepoLock(root, staleOwner, { nowMs: startMs });
    // Step: a lot of time passes with no heartbeat refresh, well past the stale threshold.
    const laterMs = startMs + 16 * 60 * 1000;
    // Step: a new owner tries to acquire; the lock must never be taken over automatically.
    const outcome = acquireSourceRepoLock(root, buildLockOwner("run-6", 60), { nowMs: laterMs });
    // Step: the outcome reports "recoverable", and the lock file is untouched.
    assert.equal(outcome.status, "recoverable");
    assert.equal((outcome as { owner: string }).owner, staleOwner);
    assert.equal(readSourceRepoLock(root)?.owner, staleOwner);
});

test("test_acquireSourceRepoLock_reportsHeldWhileTheHeartbeatStaysWarm", () => {
    // Step: an owner acquires the lock at time zero, simulating a slow box.
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-7", 70);
    const startMs = Date.parse("2026-01-01T00:00:00.000Z");
    acquireSourceRepoLock(root, owner, { nowMs: startMs });
    // Step: the run refreshes its heartbeat every few minutes, crossing what would
    // otherwise be the stale threshold if measured from acquisition alone.
    const refreshTimes = [startMs + 5 * 60 * 1000, startMs + 10 * 60 * 1000, startMs + 16 * 60 * 1000];
    for (const refreshMs of refreshTimes) {
        const refreshOutcome = refreshSourceRepoLock(root, owner, { nowMs: refreshMs });
        assert.deepEqual(refreshOutcome, { refreshed: true });
    }
    // Step: a different owner tries to acquire right after the last refresh.
    const outcome = acquireSourceRepoLock(root, buildLockOwner("run-8", 80), {
        nowMs: refreshTimes[refreshTimes.length - 1]! + 1000,
    });
    // Step: the heartbeat is warm, so the lock is "held", never "recoverable" — a live run is never taken over.
    assert.equal(outcome.status, "held");
    assert.equal((outcome as { owner: string }).owner, owner);
});

test("test_refreshSourceRepoLock_refusesToRefreshAnotherOwnersLock", () => {
    // Step: owner A holds the lock.
    const root = makeProjectRoot();
    const ownerA = buildLockOwner("run-9", 90);
    const ownerB = buildLockOwner("run-9", 91);
    acquireSourceRepoLock(root, ownerA);
    const before = readSourceRepoLock(root)!;
    // Step: owner B, who never held the lock, tries to refresh its heartbeat.
    const outcome = refreshSourceRepoLock(root, ownerB);
    // Step: the refresh is refused, and owner A's heartbeat is unchanged.
    assert.deepEqual(outcome, { refreshed: false });
    assert.equal(readSourceRepoLock(root)?.heartbeatAt, before.heartbeatAt);
});

test("test_recoverSourceRepoLock_refusesWhenTheOwnerChangedSinceTheReport", () => {
    // Step: a stale owner's lock report is taken.
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-10", 100);
    const startMs = Date.parse("2026-01-01T00:00:00.000Z");
    acquireSourceRepoLock(root, staleOwner, { nowMs: startMs });
    // Step: before recovery runs, a different owner ends up holding the lock instead.
    releaseSourceRepoLock(root, staleOwner);
    const newOwner = buildLockOwner("run-11", 110);
    acquireSourceRepoLock(root, newOwner, { nowMs: startMs });
    // Step: recovery is attempted against the original, now-stale report.
    const outcome = recoverSourceRepoLock(root, staleOwner, `abandon ${staleOwner}`, {
        nowMs: startMs + 16 * 60 * 1000,
    });
    // Step: recovery must refuse because the owner changed, and must not remove the new owner's lock.
    assert.deepEqual(outcome, { recovered: false, reason: "owner changed since the report" });
    assert.equal(readSourceRepoLock(root)?.owner, newOwner);
});

test("test_recoverSourceRepoLock_refusesAWrongConfirmationWhenCalledAsALibrary", () => {
    // Step: a stale lock exists.
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-12", 120);
    const startMs = Date.parse("2026-01-01T00:00:00.000Z");
    acquireSourceRepoLock(root, staleOwner, { nowMs: startMs });
    // Step: recovery is called directly, as a library, with a confirmation that does not match.
    const outcome = recoverSourceRepoLock(root, staleOwner, "abandon someone-else:999", {
        nowMs: startMs + 16 * 60 * 1000,
    });
    // Step: the library itself refuses; importing it cannot bypass the operator gate.
    assert.equal(outcome.recovered, false);
    assert.equal(readSourceRepoLock(root)?.owner, staleOwner);
});

test("test_sourceRepoLock_survivesAcquireAndReleaseInSeparateProcesses", () => {
    // Step: acquisition and release happen in different short-lived processes,
    // proving durability that a callback-scoped lock like withTaskStateLock cannot provide.
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-13", 130);
    const modulePath = fileURLToPath(new URL("../../scripts/tackle-tasks/sourceRepoLock.ts", import.meta.url));

    function runInSeparateProcess(functionCall: string): unknown {
        const script = `
            import { acquireSourceRepoLock, releaseSourceRepoLock } from ${JSON.stringify(modulePath)};
            process.stdout.write(JSON.stringify(${functionCall}));
        `;
        return JSON.parse(
            execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }),
        );
    }

    // Step: process one acquires the lock and exits.
    const acquireResult = runInSeparateProcess(
        `acquireSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(owner)})`,
    );
    assert.deepEqual(acquireResult, { status: "acquired" });
    // Step: the lock file is still present on disk after that process exited.
    assert.equal(readSourceRepoLock(root)?.owner, owner);
    assert.ok(readFileSync(join(root, ".git", "taskTools-source.lock"), "utf8").length > 0);

    // Step: process two, entirely separate, releases the same lock.
    const releaseResult = runInSeparateProcess(
        `releaseSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(owner)})`,
    );
    assert.deepEqual(releaseResult, { released: true });
    assert.equal(readSourceRepoLock(root), null);
});
