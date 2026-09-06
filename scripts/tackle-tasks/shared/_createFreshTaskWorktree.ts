// Shared by CREATE_WORKTREE and RESET_WORKTREE: the physical git worktree creation step, ported from createTaskWorktree.ts minus its F11 journal/rollback wrapper.
// ponytail: no journal-based rollback across process boundaries; a mid-step crash throws and leaves a partial worktree for a human to clean up. Add the journal back if a run-step block ever needs to recover one automatically.
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "../../shared/taskFiles.ts";
import { createWorktreeForGroup, modifiableFiles } from "../../shared/prepareTasks.ts";
import type { TaskGroup } from "../../shared/taskGroups.ts";
import { configureGeneratedArtifactIsolation } from "./writeTaskBrief.ts";

export function createFreshTaskWorktree(taskNumber: number, runId: string, projectRoot: string): string {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate: TaskRecord) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    const group: TaskGroup = {
        groupId: taskNumber,
        taskNumbers: [taskNumber],
        filePaths: modifiableFiles(task),
        scope: "declared",
    };
    const worktree = createWorktreeForGroup(projectRoot, group, runId);
    configureGeneratedArtifactIsolation(taskNumber, worktree);
    return worktree;
}
