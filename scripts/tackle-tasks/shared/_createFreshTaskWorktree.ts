// Shared by CREATE_WORKTREE and RESET_WORKTREE: the physical git worktree creation step.
// RETIRED (task 24): // ponytail: no journal-based rollback across process boundaries; a mid-step crash throws and leaves a partial worktree for a human to clean up. Add the journal back if a run-step block ever needs to recover one automatically.
// CREATE_WORKTREE and RESET_WORKTREE now delegate to createTaskWorktree.ts's already-tested
// F11 journal/rollback wrapper instead of calling createWorktreeForGroup directly.
import { createTaskWorktree } from "./createTaskWorktree.ts";

export function createFreshTaskWorktree(taskNumber: number, runId: string, projectRoot: string): string {
    return createTaskWorktree(taskNumber, runId, projectRoot).worktree;
}
