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

// Walks up from `root` so a shell cwd left in a subdirectory still finds the
// project's task files (mid-session `cd`s were silently breaking every skill).
export function resolveTaskFiles(root: string): TaskFilePair {
  for (let dir = root; ; dir = dirname(dir)) {
    const housed = pairIn(join(dir, ".taskTools"));
    if (existsSync(housed.tasksPath)) return housed;
    const atRoot = pairIn(dir);
    if (existsSync(atRoot.tasksPath)) return atRoot;
    if (dirname(dir) === dir) return pairIn(join(root, ".taskTools"));
  }
}

export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  for (const path of [pair.tasksPath, pair.completedTasksPath]) {
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[]\n");
  }
}

// Task numbers lead a skill invocation; free text (closureNote, flags) may follow.
// Stop at the first non-numeric token so digits inside prose — dates, "task 162",
// durations — aren't mistaken for task numbers.
export function leadingTaskNumbers(args: string[]): number[] {
  const tokens = args.join(" ").trim().split(/\s+/);
  const numeric: number[] = [];
  for (const token of tokens) {
    if (!/^[\d,]+$/.test(token)) break;
    numeric.push(...(token.match(/\d+/g) ?? []).map(Number));
  }
  return numeric;
}

export function readTaskFile(path: string): TaskRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
