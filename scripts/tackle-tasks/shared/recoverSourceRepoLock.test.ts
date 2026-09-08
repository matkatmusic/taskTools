// recoverSourceRepoLock.ts is the operator-only maintenance CLI that removes a cold
// source-repo lock. The workflow never calls it. See plans/diagram/pipeline.mmd rule 9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    acquireSourceRepoLock,
    buildLockOwner,
    readSourceRepoLock,
} from "./sourceRepoLock.ts";
import {
    formatSourceRepoLockRecoveryCommand,
    runRecoverSourceRepoLockCli,
} from "./recoverSourceRepoLock.ts";

const cliPath = fileURLToPath(new URL("./recoverSourceRepoLock.ts", import.meta.url));

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

test("test_formatSourceRepoLockRecoveryCommand_producesTheExactStdinTheCliAccepts", () => {
    // F2: rebaseTaskWorktree must be able to print byte-identical recovery command text.
    // Prove the formatter's output actually round-trips through this CLI's own JSON contract.
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-206", 206);
    acquireSourceRepoLock(root, staleOwner, { nowMs: Date.parse("2026-01-01T00:00:00.000Z") });
    const command = formatSourceRepoLockRecoveryCommand(root, staleOwner);
    // The command embeds a single-quoted JSON stdin payload and a single-quoted absolute script path.
    const embedded = command.match(/^echo '(.+)' \| node '(.+)'$/);
    assert.ok(embedded, `expected the formatted command to embed one JSON stdin payload, got: ${command}`);
    assert.ok(isAbsolute(embedded![2]), `expected the script path to be absolute, got: ${embedded![2]}`);
    const input = JSON.parse(embedded![1]);
    assert.deepEqual(input, { projectRoot: root, expectedStaleOwner: staleOwner, confirmation: `abandon ${staleOwner}` });
    // Feeding that exact payload to the CLI recovers the lock.
    const output = runRecoverSourceRepoLockCli(input);
    assert.equal(output.status, "recovered");
    assert.equal(readSourceRepoLock(root), null);
});

// M1/F2: a relative projectRoot must be rejected before the CLI ever reads or mutates a lock.
test("test_runRecoverSourceRepoLockCli_rejectsARelativeProjectRootBeforeLockAccess", () => {
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-207", 207);
    acquireSourceRepoLock(root, staleOwner, { nowMs: Date.now() - 16 * 60 * 1000 });
    const relativeRoot = relative(process.cwd(), root);

    assert.throws(
        () => runRecoverSourceRepoLockCli({
            projectRoot: relativeRoot,
            expectedStaleOwner: staleOwner,
            confirmation: `abandon ${staleOwner}`,
        }),
        /must be an absolute path/,
    );
    assert.equal(readSourceRepoLock(root)?.owner, staleOwner);
});

// M1/F2: the printed recovery command must actually work when run from an unrelated cwd —
// this is the test that would have caught the relative script path.
test("test_formatSourceRepoLockRecoveryCommand_executesFromAnUnrelatedCwd", () => {
    const root = makeProjectRoot();
    const staleOwner = buildLockOwner("run-208", 208);
    acquireSourceRepoLock(root, staleOwner, { nowMs: Date.now() - 16 * 60 * 1000 });

    const command = formatSourceRepoLockRecoveryCommand(root, staleOwner);
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "taskTools-recoverLock-unrelated-cwd-"));
    const output = execSync(command, { cwd: unrelatedCwd, encoding: "utf8" });

    assert.deepEqual(JSON.parse(output.trim()), { status: "recovered", owner: staleOwner, reason: null });
    assert.equal(readSourceRepoLock(root), null);
});

// M1/F2: a project path with whitespace and an apostrophe must round-trip through the
// shell-quoted command, recovering the intended lock and leaving an unrelated lock untouched.
test("test_formatSourceRepoLockRecoveryCommand_handlesWhitespaceAndApostropheInProjectPath", () => {
    const parent = mkdtempSync(join(tmpdir(), "taskTools-recoverLock-"));
    const root = join(parent, "o'brien's repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    const staleOwner = buildLockOwner("run-209", 209);
    acquireSourceRepoLock(root, staleOwner, { nowMs: Date.now() - 16 * 60 * 1000 });

    const otherRoot = makeProjectRoot();
    const otherOwner = buildLockOwner("run-210", 210);
    acquireSourceRepoLock(otherRoot, otherOwner, { nowMs: Date.now() - 16 * 60 * 1000 });

    const command = formatSourceRepoLockRecoveryCommand(root, staleOwner);
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "taskTools-recoverLock-unrelated-cwd-"));
    const output = execSync(command, { cwd: unrelatedCwd, encoding: "utf8" });

    assert.deepEqual(JSON.parse(output.trim()), { status: "recovered", owner: staleOwner, reason: null });
    assert.equal(readSourceRepoLock(root), null);
    assert.equal(readSourceRepoLock(otherRoot)?.owner, otherOwner);
});
