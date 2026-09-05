// Durable intent for RESET_WORKTREE's delete-then-recreate, written outside the worktree so
// it survives the worktree's own deletion (which also destroys plans/checkpoint.json).
// resumeRun.ts reads this to resume at RESET_WORKTREE instead of giving up.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeJsonAtomically } from "../../taskStateLock.ts";

export type ResetIntent = { taskNumber: number; runId: string; worktreePath: string; branch: string; createdAt: string };

export function resetIntentPath(worktreePath: string): string {
    return `${worktreePath}.reset-intent.json`;
}

export function writeResetIntent(intent: ResetIntent): void {
    writeJsonAtomically(resetIntentPath(intent.worktreePath), intent);
}

export function readRetainedResetIntent(worktreePath: string): ResetIntent | null {
    const path = resetIntentPath(worktreePath);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as ResetIntent;
}

export function clearResetIntent(worktreePath: string): void {
    unlinkSync(resetIntentPath(worktreePath));
}
