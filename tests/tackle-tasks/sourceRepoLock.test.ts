// sourceRepoLock.ts holds one durable, heartbeat-based lock on the source repository
// across many short-lived processes. See plans/diagram/pipeline.mmd rule 9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import {
    acquireSourceRepoLock,
    buildLockOwner,
    readSourceRepoLock,
    recoverSourceRepoLock,
    refreshSourceRepoLock,
    releaseSourceRepoLock,
    type AcquireOutcome,
} from "../../scripts/tackle-tasks/sourceRepoLock.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-sourceLock-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
}

const sourceRepoLockModulePath = fileURLToPath(new URL("../../scripts/tackle-tasks/sourceRepoLock.ts", import.meta.url));

// Runs `functionCall` (an expression referencing the imported lock functions, plus a
// `waitForFile(path)` busy-wait helper) in its own node process, and resolves with its
// JSON-parsed stdout. Used to force real cross-process interleavings the audit calls for.
function spawnLockCall(functionCall: string): Promise<unknown> {
    const script = `
        import {
            acquireSourceRepoLock, refreshSourceRepoLock, releaseSourceRepoLock,
            recoverSourceRepoLock, buildLockOwner,
        } from ${JSON.stringify(sourceRepoLockModulePath)};
        import { existsSync } from "node:fs";
        const WAIT = new Int32Array(new SharedArrayBuffer(4));
        function waitForFile(path) {
            while (!existsSync(path)) Atomics.wait(WAIT, 0, 0, 5);
        }
        const result = ${functionCall};
        process.stdout.write(JSON.stringify(result));
    `;
    return new Promise((resolve, reject) => {
        const child = spawn("node", ["--input-type=module", "-e", script]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("close", (code) => {
            if (code !== 0) reject(new Error(`spawnLockCall exited ${code}: ${stderr}`));
            else resolve(JSON.parse(stdout));
        });
    });
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

test("test_acquireSourceRepoLock_exactlyOneWinnerAmongAcquirersReleasedFromABarrier", async () => {
    // Step: five processes race to acquire the same lock, all held behind one barrier file.
    const root = makeProjectRoot();
    const barrierPath = join(root, "barrier");
    const owners = Array.from({ length: 5 }, (_, index) => buildLockOwner("run-300", 300 + index));
    const calls = owners.map((owner) =>
        spawnLockCall(
            `(() => { waitForFile(${JSON.stringify(barrierPath)}); `
            + `return acquireSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(owner)}); })()`,
        ),
    );
    // Step: give every process time to spawn and start waiting at the barrier.
    await wait(150);
    writeFileSync(barrierPath, "");
    const results = (await Promise.all(calls)) as AcquireOutcome[];
    // Step: exactly one process wins; every other reports held or already-held-by-me; none throws.
    const acquiredCount = results.filter((result) => result.status === "acquired").length;
    assert.equal(acquiredCount, 1);
    for (const result of results) {
        assert.ok(["acquired", "held", "already-held-by-me"].includes(result.status));
    }
    // Step: the final lock file is valid JSON naming exactly one of the racing owners.
    const finalLock = readSourceRepoLock(root);
    assert.ok(finalLock !== null);
    assert.ok(owners.includes(finalLock!.owner));
});

test("test_acquireSourceRepoLock_concurrentReaderNeverSeesAPartialLockDuringPublication", async () => {
    // Step: a write-stage seam pauses the winner right before its atomic rename.
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-310", 310);
    const pausePath = join(root, "pause-before-publish");
    const acquireCall = spawnLockCall(
        `acquireSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(owner)}, `
        + `{ testHooks: { pauseBeforePublishUntilExists: ${JSON.stringify(pausePath)} } })`,
    );
    // Step: while the winner is paused, a concurrent reader must never see a torn document.
    for (let i = 0; i < 10; i++) {
        assert.equal(readSourceRepoLock(root), null); // no lock yet, never a partial one
        await wait(10);
    }
    writeFileSync(pausePath, "");
    const result = (await acquireCall) as AcquireOutcome;
    assert.deepEqual(result, { status: "acquired" });
    assert.equal(readSourceRepoLock(root)?.owner, owner);
});

test("test_acquireSourceRepoLock_leavesNoFinalLockOrTempFileWhenTheTempWriteFails", () => {
    // Step: inject a failure between the temp-file write and its fsync.
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-320", 320);
    assert.throws(() => {
        acquireSourceRepoLock(root, owner, { testHooks: { failTempWriteBeforeFsync: true } });
    });
    // Step: neither the final lock nor its temp file survive the failure.
    assert.equal(readSourceRepoLock(root), null);
    const leftoverTempFiles = readdirSync(join(root, ".git")).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftoverTempFiles, []);
});

test("test_recoverSourceRepoLock_waitsForAPausedRefreshThenRefusesTheNowWarmHeartbeat", async () => {
    // Step: owner A holds the lock with an old-looking heartbeat.
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-330", 330);
    const staleMs = 1000;
    acquireSourceRepoLock(root, owner, { nowMs: 0, staleMs });
    // Step: A's refresh enters the guard, validates ownership, then pauses before writing.
    const pausePath = join(root, "pause-refresh");
    const refreshedMs = 5000;
    const refreshCall = spawnLockCall(
        `refreshSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(owner)}, `
        + `{ nowMs: ${refreshedMs}, testHooks: { pauseAfterValidateUntilExists: ${JSON.stringify(pausePath)} } })`,
    );
    await wait(150);
    // Step: recovery is attempted against the pre-refresh report while refresh is still paused.
    const recoveryCheckMs = refreshedMs + 500; // warm relative to the refreshed heartbeat
    const recoveryCall = spawnLockCall(
        `recoverSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(owner)}, `
        + `${JSON.stringify(`abandon ${owner}`)}, { nowMs: ${recoveryCheckMs}, staleMs: ${staleMs} })`,
    );
    await wait(150);
    // Step: recovery is still queued behind the guard; the heartbeat is still the pre-refresh one.
    assert.equal(readSourceRepoLock(root)?.heartbeatAt, new Date(0).toISOString());
    // Step: release the refresh. It publishes the fresh heartbeat, then recovery re-reads it.
    writeFileSync(pausePath, "");
    const refreshResult = await refreshCall;
    const recoveryResult = await recoveryCall;
    assert.deepEqual(refreshResult, { refreshed: true });
    assert.deepEqual(recoveryResult, { recovered: false, reason: "the lock's heartbeat is still warm" });
    assert.equal(readSourceRepoLock(root)?.owner, owner);
    assert.equal(readSourceRepoLock(root)?.heartbeatAt, new Date(refreshedMs).toISOString());
});

test("test_releaseSourceRepoLock_pausedReleaseBlocksAReplacementAcquisitionAndNeverRemovesIt", async () => {
    // Step: owner A holds the lock; its release enters the guard, validates ownership, then pauses.
    const root = makeProjectRoot();
    const ownerA = buildLockOwner("run-340", 340);
    const ownerB = buildLockOwner("run-341", 341);
    acquireSourceRepoLock(root, ownerA);
    const pausePath = join(root, "pause-release");
    const releaseCall = spawnLockCall(
        `releaseSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(ownerA)}, `
        + `{ testHooks: { pauseAfterValidateUntilExists: ${JSON.stringify(pausePath)} } })`,
    );
    await wait(150);
    // Step: B's acquisition starts while release is still paused, holding the guard.
    const acquireCall = spawnLockCall(
        `acquireSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(ownerB)})`,
    );
    await wait(150);
    // Step: acquisition cannot publish B until release completes; A's lock is still on disk.
    assert.equal(readSourceRepoLock(root)?.owner, ownerA);
    writeFileSync(pausePath, "");
    const releaseResult = await releaseCall;
    const acquireResult = await acquireCall;
    assert.deepEqual(releaseResult, { released: true });
    assert.deepEqual(acquireResult, { status: "acquired" });
    // Step: release never removes B — it had already unlinked A before B ever existed.
    assert.equal(readSourceRepoLock(root)?.owner, ownerB);
});

test("test_refreshSourceRepoLock_pausedRefreshBlocksRecoveryAndAcquisition_ownerAIsNeverOverwrittenByB", async () => {
    // Step: owner A holds the lock; its refresh enters the guard, validates ownership, then pauses.
    const root = makeProjectRoot();
    const ownerA = buildLockOwner("run-350", 350);
    const ownerB = buildLockOwner("run-351", 351);
    const staleMs = 1000;
    acquireSourceRepoLock(root, ownerA, { nowMs: 0, staleMs });
    const pausePath = join(root, "pause-refresh-vs-both");
    const refreshedMs = 5000;
    const refreshCall = spawnLockCall(
        `refreshSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(ownerA)}, `
        + `{ nowMs: ${refreshedMs}, testHooks: { pauseAfterValidateUntilExists: ${JSON.stringify(pausePath)} } })`,
    );
    await wait(150);
    // Step: both recovery of A and a replacement acquisition of B queue up behind the paused refresh.
    const recoveryCall = spawnLockCall(
        `recoverSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(ownerA)}, `
        + `${JSON.stringify(`abandon ${ownerA}`)}, { nowMs: ${refreshedMs + 500}, staleMs: ${staleMs} })`,
    );
    const acquireCall = spawnLockCall(
        `acquireSourceRepoLock(${JSON.stringify(root)}, ${JSON.stringify(ownerB)}, `
        + `{ nowMs: ${refreshedMs + 600}, staleMs: ${staleMs} })`,
    );
    await wait(150);
    writeFileSync(pausePath, "");
    const [refreshResult, recoveryResult, acquireResult] = await Promise.all([refreshCall, recoveryCall, acquireCall]);
    assert.deepEqual(refreshResult, { refreshed: true });
    // Step: recovery re-reads the now-fresh heartbeat and refuses it as warm — A is never removed.
    assert.deepEqual(recoveryResult, { recovered: false, reason: "the lock's heartbeat is still warm" });
    // Step: B can never acquire, so A can never be overwritten.
    assert.equal((acquireResult as AcquireOutcome).status, "held");
    assert.equal((acquireResult as { owner: string }).owner, ownerA);
    assert.equal(readSourceRepoLock(root)?.owner, ownerA);
    assert.equal(readSourceRepoLock(root)?.heartbeatAt, new Date(refreshedMs).toISOString());
});
