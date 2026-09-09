// Resolves tasks.json/completedTasks.json: .taskTools/ if present, else project root, else .taskTools/ (seeded on first task).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";
import { TASK_HAS_NO_TESTS, TASK_HAS_TESTS } from "./resultCodes.ts";

export type TaskRecord = { taskNumber: number; title?: string; description?: string } & Record<string, unknown>;
export type TaskFilePair = { tasksPath: string; completedTasksPath: string };

// Schema 1.0.0 uses tests ("skip" or the user's example test); 1.0.1 uses hasTests. Missing schemaVersion defaults to 1.0.0.
export function taskHasTests(task: TaskRecord): number {
  const schemaVersion = task.schemaVersion ?? "1.0.0";
  if (schemaVersion === "1.0.1") return task.hasTests === true ? TASK_HAS_TESTS : TASK_HAS_NO_TESTS;
  if (schemaVersion === "1.0.0") return typeof task.tests === "string" && task.tests !== "skip" ? TASK_HAS_TESTS : TASK_HAS_NO_TESTS;
  throw new Error(`task ${task.taskNumber} has an unknown schemaVersion ${JSON.stringify(schemaVersion)}`);
}

export function taskFilesProjectRoot(pair: TaskFilePair): string {
  const taskDirectory = dirname(pair.tasksPath)
  return basename(taskDirectory) === '.taskTools'
    ? dirname(taskDirectory)
    : taskDirectory
}

// Duplicates taskFilesProjectRoot's project-root logic on purpose: this call site only ever has a bare tasksPath string, never a full TaskFilePair.
export function taskWorkflowDirectory(tasksPath: string, taskNumber: number): string {
  const taskDirectory = dirname(tasksPath);
  const projectRoot = basename(taskDirectory) === '.taskTools' ? dirname(taskDirectory) : taskDirectory;
  return join(projectRoot, '.taskTools', 'workflows', String(taskNumber));
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

const DEFAULT_IGNORE_PATTERNS = ["__pycache__/", "node_modules/", ".DS_Store", ".taskTools/runs/", "**/plans/checkpoint.json", ".taskTools/workflows/"];

export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  const taskFolder = dirname(pair.tasksPath);
  mkdirSync(taskFolder, { recursive: true });
  // The harness watches .claude/agents only if it exists at session start; the fenced agent files land there later.
  mkdirSync(join(taskFilesProjectRoot(pair), ".claude", "agents"), { recursive: true });
  withTaskStateLock(pair.tasksPath, () => {
    seedGitignore(taskFilesProjectRoot(pair));
    for (const path of [pair.tasksPath, pair.completedTasksPath]) {
      if (!existsSync(path)) writeJsonAtomically(path, []);
    }
  });
}

// Appends only the patterns the project's .gitignore does not have yet.
function seedGitignore(projectRoot: string): void {
  const path = join(projectRoot, ".gitignore");
  const present = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const missing = DEFAULT_IGNORE_PATTERNS.filter((pattern) => !present.includes(pattern));
  if (missing.length === 0) return;
  const separator = present.length === 0 || present.at(-1) === "" ? "" : "\n";
  appendFileSync(path, `${separator}${missing.join("\n")}\n`);
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

// One array entry per line keeps tasks.json readable; older tasks hold a string.
export function goalText(goal: unknown): string {
  if (Array.isArray(goal)) return goal.map(line => String(line)).join("\n");
  return typeof goal === "string" ? goal : "";
}
