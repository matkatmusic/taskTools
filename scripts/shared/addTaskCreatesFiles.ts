// Appends paths to a task's createsFiles in .taskTools/tasks.json. The paths stay in modifiableFiles, the edit fence.
import { readFileSync } from "node:fs";
import { firstRejectedPath } from "./addTaskFiles.ts";
import { resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

export function addTaskCreatesFiles(taskNumbers: number[], paths: string[], sourceRoot: string): TaskRecord[] {
  const rejected = firstRejectedPath(paths);
  if (rejected)
    throw new Error(`addTaskCreatesFiles: rejected ${rejected}`);

  const { tasksPath } = resolveTaskFiles(sourceRoot);
  return withTaskStateLock(tasksPath, () => {
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as TaskRecord[];
    const present = new Set(tasks.map((task) => task.taskNumber));
    const missing = taskNumbers.filter((number) => !present.has(number));
    if (missing.length > 0) {
      throw new Error(`addTaskCreatesFiles: not found in tasks.json: ${missing.join(", ")}`);
    }
    for (const task of tasks) {
      if (!taskNumbers.includes(task.taskNumber))
        continue;
      const existing = Array.isArray(task.createsFiles) ? (task.createsFiles as string[]) : [];
      task.createsFiles = [...new Set([...existing, ...paths])];
    }
    writeJsonAtomically(tasksPath, tasks);
    return tasks;
  });
}
