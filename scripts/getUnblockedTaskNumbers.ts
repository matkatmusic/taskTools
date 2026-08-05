
import { type TaskRecord, leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
const pair = resolveTaskFiles(process.cwd());
const openTasks = readTaskFile(pair.tasksPath);