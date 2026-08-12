// The only script that appends a new task object to tasks.json, under the shared task-state lock.
import { readFileSync } from "node:fs";
import { resolveTaskFiles, readTaskFile } from "./taskFiles.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

function nextTaskNumberLocked(tasksPath: string, completedTasksPath: string): number {
  const numbers = [...readTaskFile(tasksPath), ...readTaskFile(completedTasksPath)].map((task) => task.taskNumber);
  return Math.max(0, ...numbers) + 1;
}

export function appendTask(
  sourceRoot: string,
  draft: Record<string, unknown>,
  { onAcquired }: { onAcquired?: () => void } = {},
): TaskRecord {
  const pair = resolveTaskFiles(sourceRoot);
  return withTaskStateLock(pair.tasksPath, () => {
    const tasks = readTaskFile(pair.tasksPath);
    const task = { ...draft, taskNumber: nextTaskNumberLocked(pair.tasksPath, pair.completedTasksPath) } as TaskRecord;
    writeJsonAtomically(pair.tasksPath, [...tasks, task]);
    return task;
  }, { onAcquired });
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function fail(problem: string): never {
  process.stderr.write(`appendTask: ${problem}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const raw = readStdin();
  if (raw === "") fail("no task object on stdin");
  let draft: Record<string, unknown>;
  try {
    draft = JSON.parse(raw);
  } catch (error) {
    fail(`stdin is not valid JSON: ${(error as Error).message}`);
  }
  const task = appendTask(process.cwd(), draft);
  process.stdout.write(`${JSON.stringify(task)}\n`);
}
