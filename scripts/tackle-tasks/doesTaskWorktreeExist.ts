// "does a worktree exist?" — plans/tackle-tasks-v1_5-plan.md Phase 3.
import { existsSync, readFileSync } from "node:fs";
import { readTaskRunState } from "./taskRunState.ts";

export type DoesTaskWorktreeExistOutput = { exists: boolean; worktree: string | null };

export function doesTaskWorktreeExist(taskNumber: number, projectRoot: string): DoesTaskWorktreeExistOutput {
    const { worktree } = readTaskRunState(taskNumber, projectRoot);
    if (worktree === null || !existsSync(worktree)) return { exists: false, worktree: null };
    return { exists: true, worktree };
}

export type DoesTaskWorktreeExistCliInput = { taskNumber: number; projectRoot: string };

if (process.argv[1]?.endsWith("doesTaskWorktreeExist.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as DoesTaskWorktreeExistCliInput;
    const output = doesTaskWorktreeExist(input.taskNumber, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
