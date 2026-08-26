// A durable, heartbeat-based lock on the source repository, held across many
// short-lived processes for the whole "rebase onto target branch" tail of a
// task workflow run. See plans/diagram/pipeline.mmd rule 9.
import {
    closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
    renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export type LockOwner = string; // `${runId}:${taskNumber}`
export type LockFile = { owner: LockOwner; acquiredAt: string; heartbeatAt: string };

export type AcquireOutcome =
    | { status: "acquired" }
    | { status: "already-held-by-me" }
    | { status: "held"; owner: LockOwner; heartbeatAt: string }
    | { status: "recoverable"; owner: LockOwner; heartbeatAt: string };

// Comfortably longer than the slowest single box, far shorter than a whole run tail.
export const STALE_HEARTBEAT_MS = 15 * 60 * 1000;

const MUTATION_GUARD_TIMEOUT_MS = 10_000;
const WAIT = new Int32Array(new SharedArrayBuffer(4));

export function buildLockOwner(runId: string, taskNumber: number): LockOwner {
    return `${runId}:${taskNumber}`;
}

// Lives under <projectRoot>/.git, never inside a linked worktree's own .git file,
// so it survives process exit and is keyed to the one real source repository.
function sourceRepoLockPath(projectRoot: string): string {
    return join(projectRoot, ".git", "taskTools-source.lock");
}

// Own path, distinct from the durable lock and from taskStateLockPath: this guard
// only makes one read/validate/write transition indivisible, it never spans boxes.
function sourceRepoLockMutationGuardPath(projectRoot: string): string {
    return join(projectRoot, ".git", "taskTools-source.lock.mutation-guard");
}

export function readSourceRepoLock(projectRoot: string): LockFile | null {
    const lockPath = sourceRepoLockPath(projectRoot);
    if (!existsSync(lockPath)) return null;
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
}

// Test-only pause seam: busy-wait until `signalPath` exists. Lets a test hold this
// process inside the guard while a concurrent process observes or queues behind it.
function waitForTestSignal(signalPath: string | undefined): void {
    if (signalPath === undefined) return;
    while (!existsSync(signalPath)) {
        Atomics.wait(WAIT, 0, 0, 5);
    }
}

export type SourceRepoLockTestHooks = {
    pauseBeforePublishUntilExists?: string;
    pauseAfterValidateUntilExists?: string;
    failTempWriteBeforeFsync?: boolean;
};

// Same wx/wait/finally shape as withTaskStateLock, but its own path and never shared
// with the task-state lock. Held by one short-lived process, so PID liveness is a
// meaningful diagnostic here even though it is meaningless for the durable source lock.
export function withSourceRepoLockMutationGuard<T>(
    projectRoot: string,
    action: () => T,
    { timeoutMs = MUTATION_GUARD_TIMEOUT_MS }: { timeoutMs?: number } = {},
): T {
    const guardPath = sourceRepoLockMutationGuardPath(projectRoot);
    mkdirSync(dirname(guardPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let fd: number | null = null;

    while (fd === null) {
        try {
            fd = openSync(guardPath, "wx", 0o600); // atomic exclusion point
            writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
            fsyncSync(fd);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline) {
                const stranded = existsSync(guardPath) ? readFileSync(guardPath, "utf8") : "(already gone)";
                throw new Error(
                    `source-lock mutation guard timed out at ${guardPath}, held by ${stranded}. `
                    + "Elapsed time alone never authorizes removing a stranded guard; inspect the PID by hand.",
                );
            }
            Atomics.wait(WAIT, 0, 0, 10);
        }
    }

    try {
        return action();
    } finally {
        closeSync(fd);
        unlinkSync(guardPath);
    }
}

// Never creates the final lock path before its complete contents exist: builds the
// complete file in a unique same-directory temp file, fsyncs, then renames onto the
// final path. Removes the temp file on every failure path.
function writeSourceRepoLockAtomically(
    projectRoot: string,
    lock: LockFile,
    testHooks?: SourceRepoLockTestHooks,
): void {
    const lockPath = sourceRepoLockPath(projectRoot);
    const tmp = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | null = null;
    try {
        fd = openSync(tmp, "wx", 0o600);
        writeFileSync(fd, JSON.stringify(lock));
        if (testHooks?.failTempWriteBeforeFsync) {
            throw new Error("injected temp-file write failure (test-only)");
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
    } catch (error) {
        if (fd !== null) closeSync(fd);
        try {
            unlinkSync(tmp);
        } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        throw error;
    }
    waitForTestSignal(testHooks?.pauseBeforePublishUntilExists);
    renameSync(tmp, lockPath);
}

export function acquireSourceRepoLock(
    projectRoot: string,
    owner: LockOwner,
    options: {
        nowMs?: number;
        staleMs?: number;
        timeoutMs?: number;
        testHooks?: SourceRepoLockTestHooks;
    } = {},
): AcquireOutcome {
    return withSourceRepoLockMutationGuard(projectRoot, (): AcquireOutcome => {
        const nowMs = options.nowMs ?? Date.now();
        const staleMs = options.staleMs ?? STALE_HEARTBEAT_MS;
        const existing = readSourceRepoLock(projectRoot);
        if (existing !== null) {
            if (existing.owner === owner) return { status: "already-held-by-me" };
            const heartbeatAgeMs = nowMs - Date.parse(existing.heartbeatAt);
            if (heartbeatAgeMs > staleMs) {
                return { status: "recoverable", owner: existing.owner, heartbeatAt: existing.heartbeatAt };
            }
            return { status: "held", owner: existing.owner, heartbeatAt: existing.heartbeatAt };
        }
        const nowIso = new Date(nowMs).toISOString();
        writeSourceRepoLockAtomically(projectRoot, { owner, acquiredAt: nowIso, heartbeatAt: nowIso }, options.testHooks);
        return { status: "acquired" };
    }, { timeoutMs: options.timeoutMs });
}

export function refreshSourceRepoLock(
    projectRoot: string,
    owner: LockOwner,
    options: { nowMs?: number; timeoutMs?: number; testHooks?: SourceRepoLockTestHooks } = {},
): { refreshed: boolean } {
    return withSourceRepoLockMutationGuard(projectRoot, () => {
        const existing = readSourceRepoLock(projectRoot);
        if (existing === null || existing.owner !== owner) return { refreshed: false };
        waitForTestSignal(options.testHooks?.pauseAfterValidateUntilExists);
        const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
        writeSourceRepoLockAtomically(projectRoot, { ...existing, heartbeatAt: nowIso }, options.testHooks);
        return { refreshed: true };
    }, { timeoutMs: options.timeoutMs });
}

// F2: the one guard every tail-script box calls before doing any work. A discarded
// {refreshed:false} is exactly the bug — this makes ignoring it impossible.
export function refreshOwnedSourceRepoLockOrThrow(projectRoot: string, owner: LockOwner): void {
    const { refreshed } = refreshSourceRepoLock(projectRoot, owner);
    if (!refreshed) throw new Error(`source repository lock is no longer owned by "${owner}"`);
}

export function releaseSourceRepoLock(
    projectRoot: string,
    owner: LockOwner,
    options: { timeoutMs?: number; testHooks?: SourceRepoLockTestHooks } = {},
): { released: boolean } {
    return withSourceRepoLockMutationGuard(projectRoot, () => {
        const existing = readSourceRepoLock(projectRoot);
        if (existing === null || existing.owner !== owner) return { released: false };
        waitForTestSignal(options.testHooks?.pauseAfterValidateUntilExists);
        unlinkSync(sourceRepoLockPath(projectRoot));
        return { released: true };
    }, { timeoutMs: options.timeoutMs });
}

// Recovery is never automatic: acquireSourceRepoLock only ever reports "recoverable".
// This is the sole path that removes a cold lock, gated on an exact confirmation string,
// and now shares the common mutation guard with acquire/refresh/release so no mutator
// ever decides from a snapshot taken outside that guard.
export function recoverSourceRepoLock(
    projectRoot: string,
    expectedStaleOwner: LockOwner,
    confirmation: string,
    options: { nowMs?: number; staleMs?: number; timeoutMs?: number; testHooks?: SourceRepoLockTestHooks } = {},
): { recovered: boolean; reason: string | null } {
    if (confirmation !== `abandon ${expectedStaleOwner}`) {
        return { recovered: false, reason: "confirmation does not match the expected stale owner" };
    }

    return withSourceRepoLockMutationGuard(projectRoot, () => {
        const existing = readSourceRepoLock(projectRoot);
        if (existing === null) return { recovered: false, reason: "no lock is held" };
        if (existing.owner !== expectedStaleOwner) return { recovered: false, reason: "owner changed since the report" };
        const nowMs = options.nowMs ?? Date.now();
        const staleMs = options.staleMs ?? STALE_HEARTBEAT_MS;
        const heartbeatAgeMs = nowMs - Date.parse(existing.heartbeatAt);
        if (heartbeatAgeMs <= staleMs) return { recovered: false, reason: "the lock's heartbeat is still warm" };
        waitForTestSignal(options.testHooks?.pauseAfterValidateUntilExists);
        unlinkSync(sourceRepoLockPath(projectRoot));
        return { recovered: true, reason: null };
    }, { timeoutMs: options.timeoutMs });
}
