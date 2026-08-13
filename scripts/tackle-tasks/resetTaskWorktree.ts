// "reset the worktree" — plans/tackle-tasks-v1_5-plan.md Phase 3.
// Adopt or release the old lease, then wipe merge persistence, then the worktree and branch,
// then create a fresh one. Every step idempotent so a half-finished reset re-runs safely.
import { readFileSync } from "node:fs";
import { releaseTaskWorktreeLease } from "../prepareTasks.ts";
import { removeWorktreeAndBranch, deleteTaskMergePersistence } from "../mergeTaskWorktrees.ts";
import { adoptWorktreeLease, readTaskRunState } from "./taskRunState.ts";
import { createTaskWorktree, taskBranchName, type CreateTaskWorktreeOutput } from "./createTaskWorktree.ts";

export function resetTaskWorktree(taskNumber: number, runId: string, projectRoot: string): CreateTaskWorktreeOutput {
    const state = readTaskRunState(taskNumber, projectRoot);
    const branch = taskBranchName(taskNumber);

    if (state.worktree !== null && state.leaseRunId !== null) {
        const { adopted } = adoptWorktreeLease(taskNumber, runId, projectRoot);
        if (!adopted) {
            try {
                releaseTaskWorktreeLease({ worktreePath: state.worktree, runId: state.leaseRunId });
            } catch {
                // ponytail: best-effort — a lease already released or owned by someone else is not this box's problem.
            }
        }
    }

    deleteTaskMergePersistence(projectRoot, branch);
    if (state.worktree !== null) removeWorktreeAndBranch(projectRoot, state.worktree, branch);

    return createTaskWorktree(taskNumber, runId, projectRoot);
}

export type ResetTaskWorktreeCliInput = { taskNumber: number; runId: string; projectRoot: string };

if (process.argv[1]?.endsWith("resetTaskWorktree.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ResetTaskWorktreeCliInput;
    const output = resetTaskWorktree(input.taskNumber, input.runId, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
