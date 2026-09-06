// The one file the hook writes before every block, so a killed run can continue at that block. Lives inside the task worktree.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile } from "./readJsonFile.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";

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
    return readJsonFile(path) as Checkpoint;
}

export function writeCheckpoint(worktree: string, checkpoint: Checkpoint): void {
    const path = checkpointPath(worktree);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomically(path, checkpoint);
}
