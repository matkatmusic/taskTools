// Resolves a project's tasks.json / completedTasks.json pair: .taskTools/ when present,
// project root otherwise (pre-plugin repos keep their root files); neither present -> the
// .taskTools/ pair, which seedTaskFilesIfAbsent creates on first task creation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TaskRecord = { taskNumber: number; title?: string; description?: string } & Record<string, unknown>;
export type TaskFilePair = { tasksPath: string; completedTasksPath: string };

function pairIn(folder: string): TaskFilePair {
  return { tasksPath: join(folder, "tasks.json"), completedTasksPath: join(folder, "completedTasks.json") };
}

export function resolveTaskFiles(root: string): TaskFilePair {
  const housed = pairIn(join(root, ".taskTools"));
  if (existsSync(housed.tasksPath)) return housed;
  const atRoot = pairIn(root);
  if (existsSync(atRoot.tasksPath)) return atRoot;
  return housed;
}

export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  for (const path of [pair.tasksPath, pair.completedTasksPath]) {
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[]\n");
  }
}

export function readTaskFile(path: string): TaskRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
