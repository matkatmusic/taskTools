// Resume-this-block intent stashed outside the checkpoint by resetTask.ts, read by REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts and IS_REBASE_FINISHED_Q.ts.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";

export type RebaseIntent = { taskNumber: number; runId: string; targetBlock: string; targetInput: string };

export function rebaseIntentPath(worktreePath: string): string {
  return `${worktreePath}.rebase-intent.json`;
}

export function writeRebaseIntent(worktreePath: string, intent: RebaseIntent): void {
  writeJsonAtomically(rebaseIntentPath(worktreePath), intent);
}

export function readRetainedRebaseIntent(worktreePath: string): RebaseIntent | null {
  const path = rebaseIntentPath(worktreePath);
  if (!existsSync(path))
    return null;
  return JSON.parse(readFileSync(path, "utf8")) as RebaseIntent;
}

export function clearRebaseIntent(worktreePath: string): void {
  unlinkSync(rebaseIntentPath(worktreePath));
}
