// recoverSourceRepoLock.ts is the operator-only maintenance CLI that removes a cold
// source-repo lock. The workflow never calls it. See plans/diagram/pipeline.mmd rule 9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    acquireSourceRepoLock,
    buildLockOwner,
    readSourceRepoLock,
} from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { runRecoverSourceRepoLockCli } from "../../scripts/tackle-tasks/recoverSourceRepoLock.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/recoverSourceRepoLock.ts", import.meta.url));

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-recoverLock-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
}

function runCli(input: unknown): { status: string; owner: string; reason: string | null } {
    const output = execFileSync("node", [cliPath], {
        input: JSON.stringify(input),
        encoding: "utf8",
    });
    return JSON.parse(output.trim());
}

test("test_recoverSourceRepoLockCli_requiresTheExactConfirmation", () => {
    // Step: a stale lock exists.
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-200", 200);
    acquireSourceRepoLock(root, staleOwner, { nowMs: Date.parse("2026-01-01T00:00:00.000Z") });
    // Step: the CLI is invoked with a confirmation string that does not match the owner.
    const output = runCli({
        projectRoot: root,
        expectedStaleOwner: staleOwner,
        confirmation: "abandon the-wrong-owner:1",
    });
    // Step: the CLI must refuse, and the lock must remain in place.
    assert.equal(output.status, "refused");
    assert.equal(readSourceRepoLock(root)?.owner, staleOwner);
});

test("test_recoverSourceRepoLockCli_refusesAWarmLock", () => {
    // Step: a lock exists and its heartbeat is warm (freshly acquired, no elapsed time injected).
    const root = makeProjectRoot();
    const owner = buildLockOwner("run-201", 201);
    acquireSourceRepoLock(root, owner);
    // Step: the CLI is invoked with the exact confirmation, but the lock has not gone cold.
    const output = runCli({
        projectRoot: root,
        expectedStaleOwner: owner,
        confirmation: `abandon ${owner}`,
    });
    // Step: the CLI must refuse a warm lock, and must not remove it.
    assert.equal(output.status, "refused");
    assert.equal(readSourceRepoLock(root)?.owner, owner);
});

test("test_recoverSourceRepoLockCli_refusesWhenTheOwnerChanged", () => {
    // Step: the reported stale owner is not the owner actually holding the lock.
    const root = makeProjectRoot();
    const actualOwner = buildLockOwner("run-202", 202);
    const reportedStaleOwner = buildLockOwner("run-202", 999);
    acquireSourceRepoLock(root, actualOwner);
    // Step: the CLI is invoked against the wrong, reported-stale owner.
    const output = runCli({
        projectRoot: root,
        expectedStaleOwner: reportedStaleOwner,
        confirmation: `abandon ${reportedStaleOwner}`,
    });
    // Step: the CLI must refuse, and the real owner's lock must remain in place.
    assert.equal(output.status, "refused");
    assert.equal(readSourceRepoLock(root)?.owner, actualOwner);
});

test("test_recoverSourceRepoLockCli_allowsTheNextRunToAcquireAfterConfirmedRecovery", () => {
    // Step: a task workflow acquires the lock. Its heartbeat is stamped 16 real-clock
    // minutes in the past, so the CLI's own (real) clock sees it as already cold —
    // no 15-minute sleep needed.
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-203", 203);
    acquireSourceRepoLock(root, staleOwner, { nowMs: Date.now() - 16 * 60 * 1000 });

    // Step: the operator runs the CLI with the exact required confirmation.
    const recoverOutput = runCli({
        projectRoot: root,
        expectedStaleOwner: staleOwner,
        confirmation: `abandon ${staleOwner}`,
    });
    // Step: recovery succeeds and the lock file is gone.
    assert.deepEqual(recoverOutput, { status: "recovered", owner: staleOwner, reason: null });
    assert.equal(readSourceRepoLock(root), null);

    // Step: the next run's owner can now acquire the lock normally.
    const nextOwner = buildLockOwner("run-204", 204);
    const acquireOutcome = acquireSourceRepoLock(root, nextOwner);
    assert.deepEqual(acquireOutcome, { status: "acquired" });
});

test("test_recoverSourceRepoLockCli_refusesAMalformedOwnerToken", () => {
    // Step: the reported stale owner is missing its ":taskNumber" half.
    const root = makeProjectRoot();
    const malformedOwner = "run-205-with-no-task-number";
    // Step: the CLI is invoked with that malformed token.
    const output = runRecoverSourceRepoLockCli({
        projectRoot: root,
        expectedStaleOwner: malformedOwner,
        confirmation: `abandon ${malformedOwner}`,
    });
    // Step: the CLI must refuse before it ever reads the lock file.
    assert.equal(output.status, "refused");
    assert.equal(output.reason, "malformed owner token");
});
