// The one file the hook writes before every block, so a killed run can continue at that block. Lives inside the task worktree.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Checkpoint = {
    taskNumber: number;
    passId: string;
    runId: string;
    projectRoot: string;
    block: string;
    input: string;
    state: "running" | "failed";
    sourceLockHeld: boolean;
    exitType: string;
    exitNote: string;
    resumedFrom: { block: string; exitType: string; exitNote: string } | null;
};

export function checkpointPath(worktree: string): string {
    return join(worktree, "plans", "checkpoint.json");
}

export function readCheckpoint(worktree: string): Checkpoint | null {
    const path = checkpointPath(worktree);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
}

export function writeCheckpoint(worktree: string, checkpoint: Checkpoint): void {
    const path = checkpointPath(worktree);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(checkpoint, null, 4)}\n`);
}
