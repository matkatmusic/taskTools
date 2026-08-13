// "create a worktree" — plans/tackle-tasks-v1_5-plan.md Phase 3.
import { readFileSync } from "node:fs";
import { createWorktreeForGroup } from "../prepareTasks.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import type { TaskGroup } from "../taskGroups.ts";
import { configureGeneratedArtifactIsolation } from "./writeTaskBrief.ts";
import { updateCurrentTaskRun } from "./taskRunState.ts";

export function taskBranchName(taskNumber: number): string {
    return `task-${taskNumber}`;
}

export type CreateTaskWorktreeOutput = { worktree: string; branch: string };

export function createTaskWorktree(taskNumber: number, runId: string, projectRoot: string): CreateTaskWorktreeOutput {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    const group: TaskGroup = {
        groupId: taskNumber,
        taskNumbers: [taskNumber],
        filePaths: Array.isArray(task.files) ? (task.files as string[]) : [],
        scope: "declared",
    };
    const worktree = createWorktreeForGroup(projectRoot, group, runId);
    const branch = taskBranchName(taskNumber);
    updateCurrentTaskRun(taskNumber, { worktree, leaseRunId: runId }, projectRoot);
    configureGeneratedArtifactIsolation(taskNumber, worktree);
    return { worktree, branch };
}

export type CreateTaskWorktreeCliInput = { taskNumber: number; runId: string; projectRoot: string };

if (process.argv[1]?.endsWith("createTaskWorktree.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CreateTaskWorktreeCliInput;
    const output = createTaskWorktree(input.taskNumber, input.runId, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
