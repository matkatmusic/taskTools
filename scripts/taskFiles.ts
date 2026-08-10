// Resolves tasks.json/completedTasks.json: .taskTools/ if present, else project root, else .taskTools/ (seeded on first task).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

export type TaskRecord = { taskNumber: number; title?: string; description?: string } & Record<string, unknown>;
export type TaskFilePair = { tasksPath: string; completedTasksPath: string };

export function taskFilesProjectRoot(pair: TaskFilePair): string {
  const taskDirectory = dirname(pair.tasksPath)
  return basename(taskDirectory) === '.taskTools'
    ? dirname(taskDirectory)
    : taskDirectory
}

function pairIn(folder: string): TaskFilePair {
  return { tasksPath: join(folder, "tasks.json"), completedTasksPath: join(folder, "completedTasks.json") };
}

// Walks up from `root` so a shell cwd left in a subdirectory still finds the project's task files (mid-session `cd`s were silently breaking every skill).
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
  mkdirSync(dirname(pair.tasksPath), { recursive: true });
  withTaskStateLock(pair.tasksPath, () => {
    for (const path of [pair.tasksPath, pair.completedTasksPath]) {
      if (!existsSync(path)) writeJsonAtomically(path, []);
    }
  });
}

// Task numbers lead a skill invocation; free text (closureNote, flags) may follow.  Stop at the first non-numeric token so digits inside prose — dates, "task 162", durations — aren't mistaken for task numbers.  Brackets and stray quotes are tolerated so a single no-space JSON array token — [268,270,281], the shell-safe form skills pass as "$1" — parses like bare numbers.
export function leadingTaskNumbers(args: string[]): number[] {
  const tokens = args.join(" ").trim().split(/\s+/);
  const numeric: number[] = [];
  for (const token of tokens) {
    if (!/^["'[\]\d,]+$/.test(token)) break;
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
