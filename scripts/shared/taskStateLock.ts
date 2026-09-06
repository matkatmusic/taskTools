// One mutex guarding every tasks.json/completedTasks.json/run-arguments.json writer under a root.
import {
    closeSync, fsyncSync, mkdirSync, openSync,
    renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const WAIT = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_TIMEOUT_MS = 10_000;

// tasksPath is pre-resolved, so root and subdirectory callers share one lock.
export function taskStateLockPath(tasksPath: string): string {
    return join(dirname(tasksPath), "task-state.lock");
}

// ponytail: no stale-lock age reap, that's its own check-then-act race; fails safe on timeout.
export function withTaskStateLock<T>(
    tasksPath: string,
    action: () => T,
    { timeoutMs = DEFAULT_TIMEOUT_MS, onAcquired }: { timeoutMs?: number; onAcquired?: () => void } = {},
): T {
    const lockPath = taskStateLockPath(tasksPath);
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let fd: number | null = null;

    while (fd === null) {
        try {
            fd = openSync(lockPath, "wx", 0o600); // atomic exclusion point
            writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
            fsyncSync(fd);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline) {
                throw new Error(`task-state lock timed out; inspect stale lock manually: ${lockPath}`);
            }
            Atomics.wait(WAIT, 0, 0, 10);
        }
    }

    try {
        onAcquired?.();
        return action();
    } finally {
        closeSync(fd);
        try {
            unlinkSync(lockPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}

export function writeJsonAtomically(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
}
