// A durable, heartbeat-based lock on the source repository, held across many
// short-lived processes for the whole "rebase onto target branch" tail of a
// task workflow run. See plans/diagram/pipeline.mmd rule 9.
import {
    closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
    renameSync, unlinkSync, writeFileSync,
} from "node:fs";
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

export function buildLockOwner(runId: string, taskNumber: number): LockOwner {
    return `${runId}:${taskNumber}`;
}

// Lives under <projectRoot>/.git, never inside a linked worktree's own .git file,
// so it survives process exit and is keyed to the one real source repository.
function sourceRepoLockPath(projectRoot: string): string {
    return join(projectRoot, ".git", "taskTools-source.lock");
}

export function readSourceRepoLock(projectRoot: string): LockFile | null {
    const lockPath = sourceRepoLockPath(projectRoot);
    if (!existsSync(lockPath)) return null;
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
}

function writeSourceRepoLockAtomically(projectRoot: string, lock: LockFile): void {
    const lockPath = sourceRepoLockPath(projectRoot);
    const tmp = `${lockPath}.${process.pid}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify(lock));
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, lockPath);
}

export function acquireSourceRepoLock(
    projectRoot: string,
    owner: LockOwner,
    options: { nowMs?: number; staleMs?: number } = {},
): AcquireOutcome {
    const nowMs = options.nowMs ?? Date.now();
    const staleMs = options.staleMs ?? STALE_HEARTBEAT_MS;
    const lockPath = sourceRepoLockPath(projectRoot);
    mkdirSync(dirname(lockPath), { recursive: true });

    let fd: number;
    try {
        fd = openSync(lockPath, "wx", 0o600); // atomic exclusion point
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = readSourceRepoLock(projectRoot);
        if (existing === null) return acquireSourceRepoLock(projectRoot, owner, options); // raced past deletion
        if (existing.owner === owner) return { status: "already-held-by-me" };
        const heartbeatAgeMs = nowMs - Date.parse(existing.heartbeatAt);
        if (heartbeatAgeMs > staleMs) {
            return { status: "recoverable", owner: existing.owner, heartbeatAt: existing.heartbeatAt };
        }
        return { status: "held", owner: existing.owner, heartbeatAt: existing.heartbeatAt };
    }

    try {
        const nowIso = new Date(nowMs).toISOString();
        writeFileSync(fd, JSON.stringify({ owner, acquiredAt: nowIso, heartbeatAt: nowIso }));
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    return { status: "acquired" };
}

export function refreshSourceRepoLock(
    projectRoot: string,
    owner: LockOwner,
    options: { nowMs?: number } = {},
): { refreshed: boolean } {
    const existing = readSourceRepoLock(projectRoot);
    if (existing === null || existing.owner !== owner) return { refreshed: false };
    const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
    writeSourceRepoLockAtomically(projectRoot, { ...existing, heartbeatAt: nowIso });
    return { refreshed: true };
}

export function releaseSourceRepoLock(projectRoot: string, owner: LockOwner): { released: boolean } {
    const existing = readSourceRepoLock(projectRoot);
    if (existing === null || existing.owner !== owner) return { released: false };
    unlinkSync(sourceRepoLockPath(projectRoot));
    return { released: true };
}

// Recovery is never automatic: acquireSourceRepoLock only ever reports "recoverable".
// This is the sole path that removes a cold lock, gated on an exact confirmation string
// and re-checked under its own exclusive guard so two operators can't race a recovery.
export function recoverSourceRepoLock(
    projectRoot: string,
    expectedStaleOwner: LockOwner,
    confirmation: string,
    options: { nowMs?: number; staleMs?: number } = {},
): { recovered: boolean; reason: string | null } {
    if (confirmation !== `abandon ${expectedStaleOwner}`) {
        return { recovered: false, reason: "confirmation does not match the expected stale owner" };
    }

    const lockPath = sourceRepoLockPath(projectRoot);
    const guardPath = `${lockPath}.recovery-guard`;
    mkdirSync(dirname(lockPath), { recursive: true });

    let guardFd: number;
    try {
        guardFd = openSync(guardPath, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { recovered: false, reason: "a recovery is already in progress" };
        }
        throw error;
    }

    try {
        const existing = readSourceRepoLock(projectRoot);
        if (existing === null) return { recovered: false, reason: "no lock is held" };
        if (existing.owner !== expectedStaleOwner) return { recovered: false, reason: "owner changed since the report" };
        const nowMs = options.nowMs ?? Date.now();
        const staleMs = options.staleMs ?? STALE_HEARTBEAT_MS;
        const heartbeatAgeMs = nowMs - Date.parse(existing.heartbeatAt);
        if (heartbeatAgeMs <= staleMs) return { recovered: false, reason: "the lock's heartbeat is still warm" };
        unlinkSync(lockPath);
        return { recovered: true, reason: null };
    } finally {
        closeSync(guardFd);
        unlinkSync(guardPath);
    }
}
