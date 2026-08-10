// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { existsSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { resolveRunArgumentsPath } from "./prepareTasks.ts";
import { hashGuardedRewrite } from "./closeTasks.ts";

const FILES_KEY = "files" as const; // repoint here if task 58 splits files into modifiableFiles/readOnlyFiles

// Repo-relative only: blocks a planner-reported path from escaping the ownership boundary.
function rejectionReason(path: string): string | null {
    if (path === "") return "empty path";
    if (isAbsolute(path)) return `absolute path: ${path}`;
    if (path === "." || path === "..") return `path: ${path}`;
    const normalized = normalize(path);
    if (normalized === ".." || normalized.startsWith("../")) return `path outside repo: ${path}`;
    return null;
}

function firstRejectedPath(paths: string[]): string | null {
    for (const path of paths) {
        const reason = rejectionReason(path);
        if (reason) return reason;
    }
    return null;
}

function appendFiles(task: TaskRecord, paths: string[]): void {
    const existing = Array.isArray(task[FILES_KEY]) ? (task[FILES_KEY] as string[]) : [];
    const seen = new Set(existing);
    const merged = [...existing];
    for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        merged.push(path);
    }
    task[FILES_KEY] = merged;
}

type RunArgumentsSnapshot = { groups: { tasks: { number: number; files: string[] }[] }[] } & Record<string, unknown>;

function refreshRunArgumentsSnapshot(
    repoRoot: string,
    tasks: TaskRecord[],
    afterRunArgumentsWriteTmp?: () => void,
): void {
    const argumentsPath = resolveRunArgumentsPath(repoRoot);
    if (!existsSync(argumentsPath)) return;
    const filesByNumber = new Map(tasks.map((task) => [task.taskNumber, (task[FILES_KEY] as string[] | undefined) ?? []]));
    hashGuardedRewrite<RunArgumentsSnapshot>(
        argumentsPath,
        (snapshot) => {
            for (const group of snapshot.groups) {
                for (const task of group.tasks) {
                    const widened = filesByNumber.get(task.number);
                    if (!widened) continue;
                    const merged = [...task.files];
                    const seen = new Set(merged);
                    for (const path of widened) {
                        if (seen.has(path)) continue;
                        seen.add(path);
                        merged.push(path);
                    }
                    task.files = merged;
                }
            }
            return snapshot;
        },
        afterRunArgumentsWriteTmp,
    );
}

// Guarded via hashGuardedRewrite; repoRoot mirrors closeTasks()'s projectRoot, not always process.cwd().
export function addTaskFiles(
    taskNumbers: number[],
    paths: string[],
    repoRoot: string = process.cwd(),
    afterTasksWriteTmp?: () => void,
    afterRunArgumentsWriteTmp?: () => void,
): TaskRecord[] {
    const rejected = firstRejectedPath(paths);
    if (rejected) throw new Error(`addTaskFiles: rejected ${rejected}`);
    const pair = resolveTaskFiles(repoRoot);
    const tasks = hashGuardedRewrite<TaskRecord[]>(
        pair.tasksPath,
        (parsedTasks) => {
            const present = new Set(parsedTasks.map((task) => task.taskNumber));
            const missing = taskNumbers.filter((number) => !present.has(number));
            if (missing.length > 0) {
                throw new Error(`addTaskFiles: not found in tasks.json: ${missing.join(", ")}`);
            }
            for (const task of parsedTasks) {
                if (taskNumbers.includes(task.taskNumber)) appendFiles(task, paths);
            }
            return parsedTasks;
        },
        afterTasksWriteTmp,
    );
    refreshRunArgumentsSnapshot(repoRoot, tasks, afterRunArgumentsWriteTmp);
    return tasks;
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const argv = process.argv.slice(2);
    const numbers = leadingTaskNumbers(argv);
    const paths = argv.slice(1);
    try {
        addTaskFiles(numbers, paths, repoRoot);
    } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
