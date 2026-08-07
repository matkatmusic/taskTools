// Task lookup helpers, plus a CLI that prints them to stdout for skill injection.
import { type TaskRecord, leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export function describeTask(taskNumber: number, openTasks: TaskRecord[], completedTasks: TaskRecord[]): string {
  const open = openTasks.find(t => t.taskNumber === taskNumber);
  if (open) return `task ${taskNumber} (OPEN):\n${JSON.stringify(open, null, 2)}`;
  const completed = completedTasks.find(t => t.taskNumber === taskNumber);
  if (completed) return `task ${taskNumber} (COMPLETED):\n${JSON.stringify(completed, null, 2)}`;
  return `task ${taskNumber}: not found in tasks.json or completedTasks.json`;
}

export function listTaskTitles(tag: string, tasks: TaskRecord[]): string[] {
  return tasks.map(t => {
    const blockedBy = Array.isArray(t.blockedBy) ? (t.blockedBy as { taskNum: number; reason: string }[]) : [];
    const blockers = blockedBy.length > 0 ? ` [blockedBy: ${blockedBy.map(b => `${b.taskNum} (${b.reason})`).join(", ")}]` : "";
    return `${tag} ${t.taskNumber}: ${t.title}${blockers}`;
  });
}

export function readTaskLists(projectRoot: string = process.cwd()): {
  openTasks: TaskRecord[];
  completedTasks: TaskRecord[];
} {
  const pair = resolveTaskFiles(projectRoot);
  return { openTasks: readTaskFile(pair.tasksPath), completedTasks: readTaskFile(pair.completedTasksPath) };
}

// Open tasks win over completed ones, matching describeTask's lookup order.
export function findTask(taskNumber: number, projectRoot: string = process.cwd()): TaskRecord | undefined {
  const { openTasks, completedTasks } = readTaskLists(projectRoot);
  return openTasks.find(t => t.taskNumber === taskNumber) ?? completedTasks.find(t => t.taskNumber === taskNumber);
}

export function taskDetailsReport(taskNumbers: number[], projectRoot: string = process.cwd()): string {
  const { openTasks, completedTasks } = readTaskLists(projectRoot);
  const report =
    taskNumbers.length === 0
      ? [...listTaskTitles("OPEN", openTasks), ...listTaskTitles("DONE", completedTasks)]
      : taskNumbers.map(n => describeTask(n, openTasks, completedTasks));
  return report.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(taskDetailsReport(leadingTaskNumbers(process.argv.slice(2))));
}
