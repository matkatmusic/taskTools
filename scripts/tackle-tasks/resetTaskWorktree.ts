// "reset the worktree" — plans/tackle-tasks-v1_5-plan.md Phase 3.
// F4: transitionWorktreeLease decides adopt/release/absent/refused atomically, re-reading
// state inside the lock and lease guard. A refusal aborts before persistence, branch or
// worktree removal — never swallow it and delete a worktree another run still owns.
import { readFileSync } from "node:fs";
import { releaseTaskWorktreeLease } from "../prepareTasks.ts";
import { removeWorktreeAndBranch, deleteTaskMergePersistence } from "../mergeTaskWorktrees.ts";
import { readTaskRunState, transitionWorktreeLease } from "./taskRunState.ts";
import { createTaskWorktree, taskBranchName, type CreateTaskWorktreeOutput } from "./createTaskWorktree.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export function resetTaskWorktree(taskNumber: number, runId: string, projectRoot: string): CreateTaskWorktreeOutput {
    const outcome = transitionWorktreeLease(taskNumber, runId, projectRoot);
    if (outcome.status === "refused-owner-mismatch") {
        throw new Error(
            `worktree lease for task ${taskNumber} is held by run "${outcome.heldByRunId}", refusing reset`,
        );
    }

    const state = readTaskRunState(taskNumber, projectRoot);
    const branch = taskBranchName(taskNumber);

    // "adopted" only confirms expectedRunId already owns the physical lease — the worktree is
    // about to be deleted and recreated, so the lease that names us still has to come off disk
    // or the fresh acquire in createTaskWorktree refuses it as already-owned.
    if (outcome.status === "adopted" && state.worktree !== null) {
        releaseTaskWorktreeLease({ worktreePath: state.worktree, runId });
    }

    deleteTaskMergePersistence(projectRoot, branch);
    if (state.worktree !== null) removeWorktreeAndBranch(projectRoot, state.worktree, branch);

    return createTaskWorktree(taskNumber, runId, projectRoot);
}

export type ResetTaskWorktreeCliInput = { taskNumber: number; runId: string; projectRoot: string };

// CLI entrypoint migrated to scripts/steps/pipeline-worktreeCheck/TAKE_WORKTREE_LEASE_BEFORE_RESET.ts
// and RESET_WORKTREE.ts (split into a lease-transition step and a teardown/recreate step).
// if (process.argv[1]?.endsWith("resetTaskWorktree.ts")) {
//     const input = JSON.parse(readFileSync(0, "utf8")) as ResetTaskWorktreeCliInput;
//     const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
//     const output = resetTaskWorktree(input.taskNumber, input.runId, projectRoot);
//     process.stdout.write(`${JSON.stringify(output)}\n`);
// }
