// "does a worktree exist?" — plans/tackle-tasks-v1_5-plan.md Phase 3.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTaskWorktreeConventionDirectory } from "../../shared/prepareTasks.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type DoesTaskWorktreeExistOutput = { exists: boolean; worktree: string | null };

// The conventional path is derived, never read back from run state: a run that ends with its
// worktree retained clears the recorded pointer while the directory and its lease survive.
export function doesTaskWorktreeExist(taskNumber: number, projectRoot: string): DoesTaskWorktreeExistOutput {
    const worktree = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
    if (!existsSync(worktree)) return { exists: false, worktree: null };
    return { exists: true, worktree };
}

export type DoesTaskWorktreeExistCliInput = { taskNumber: number; projectRoot: string };

// CLI entrypoint migrated to scripts/steps/pipeline-worktreeCheck/DOES_WORKTREE_EXIST.ts.
// if (process.argv[1]?.endsWith("doesTaskWorktreeExist.ts")) {
//     const input = JSON.parse(readFileSync(0, "utf8")) as DoesTaskWorktreeExistCliInput;
//     const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
//     const output = doesTaskWorktreeExist(input.taskNumber, projectRoot);
//     process.stdout.write(`${JSON.stringify(output)}\n`);
// }
