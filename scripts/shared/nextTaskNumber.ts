// Prints the next free taskNumber: highest across tasks.json and completedTasks.json, plus 1.
// Output goes to stdout because the create-task skill injects it via a !`node ...` command.
// First run in a project with no task files seeds .taskTools/ with empty ones.
import { readTaskFile, resolveTaskFiles, seedTaskFilesIfAbsent } from "./taskFiles.ts";

const pair = resolveTaskFiles(process.cwd());
seedTaskFilesIfAbsent(pair);
const taskNumbers = [...readTaskFile(pair.tasksPath), ...readTaskFile(pair.completedTasksPath)]
  .map(t => t.taskNumber);
process.stdout.write(`${Math.max(0, ...taskNumbers) + 1}\n`);
