// Prints the full JSON object for each task number given as an argument,
// looking in tasks.json (open) first, then completedTasks.json.
// With NO arguments, prints one "OPEN|DONE <n>: <title>" line per task instead.
// Output goes to stdout because skills inject it via a !`node ...` command.
import { type TaskRecord, leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

function describeTask(taskNumber: number, openTasks: TaskRecord[], completedTasks: TaskRecord[]): string {
  const open = openTasks.find(t => t.taskNumber === taskNumber);
  if (open) return `task ${taskNumber} (OPEN):\n${JSON.stringify(open, null, 2)}`;
  const completed = completedTasks.find(t => t.taskNumber === taskNumber);
  if (completed) return `task ${taskNumber} (COMPLETED):\n${JSON.stringify(completed, null, 2)}`;
  return `task ${taskNumber}: not found in tasks.json or completedTasks.json`;
}

const pair = resolveTaskFiles(process.cwd());
const openTasks = readTaskFile(pair.tasksPath);
const completedTasks = readTaskFile(pair.completedTasksPath);
function listTaskTitles(tag: string, tasks: TaskRecord[]): string[] {
  return tasks.map(t => {
    const blockers = Array.isArray(t.blockedBy) && t.blockedBy.length > 0 ? ` [blockedBy: ${t.blockedBy.join(",")}]` : "";
    return `${tag} ${t.taskNumber}: ${t.title}${blockers}`;
  });
}

const taskNumbers = leadingTaskNumbers(process.argv.slice(2));
const report =
  taskNumbers.length === 0
    ? [...listTaskTitles("OPEN", openTasks), ...listTaskTitles("DONE", completedTasks)]
    : taskNumbers.map(n => describeTask(n, openTasks, completedTasks));
process.stdout.write(report.join("\n") + "\n");
