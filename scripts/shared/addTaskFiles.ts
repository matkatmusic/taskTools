// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, resolveTaskFiles, taskFilesProjectRoot, type TaskRecord } from "./taskFiles.ts";
import { resolveRunArgumentsPath } from "./prepareTasks.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

// const FILES_KEY = "files" as const; // retired by task 192: each reader resolves the key per task

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
    // const key = Array.isArray(task.modifiableFiles) ? "modifiableFiles" : "files"; // retired: "files" key no longer supported
    const key = "modifiableFiles";
    const existing = Array.isArray(task[key]) ? (task[key] as string[]) : [];
    const seen = new Set(existing);
    const merged = [...existing];
    for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        merged.push(path);
    }
    // task[key] = merged; // retired: dynamic key could resolve to "files"
    task.modifiableFiles = merged;
}

export type RunArgumentsSnapshot = { groups: { tasks: { number: number; files: string[] }[] }[] } & Record<string, unknown>;

export function refreshRunArgumentsSnapshotInMemory(snapshot: RunArgumentsSnapshot, tasks: TaskRecord[]): void {
    const filesByNumber = new Map(tasks.map((task) => {
        // const key = Array.isArray(task.modifiableFiles) ? "modifiableFiles" : "files"; // retired: "files" key no longer supported
        const key = "modifiableFiles";
        return [task.taskNumber, (task[key] as string[] | undefined) ?? []];
    }));
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
}

export function addTaskFiles(
    taskNumbers: number[],
    paths: string[],
    sourceRoot: string,
    { onAcquired }: { onAcquired?: () => void } = {},
): TaskRecord[] {
    const rejected = firstRejectedPath(paths);
    if (rejected) throw new Error(`addTaskFiles: rejected ${rejected}`);

    const pair = resolveTaskFiles(sourceRoot);
    const authoritativeRoot = taskFilesProjectRoot(pair);
    return withTaskStateLock(pair.tasksPath, () => {
        const tasks = JSON.parse(readFileSync(pair.tasksPath, "utf8")) as TaskRecord[];
        const present = new Set(tasks.map((task) => task.taskNumber));
        const missing = taskNumbers.filter((number) => !present.has(number));
        if (missing.length > 0) {
            throw new Error(`addTaskFiles: not found in tasks.json: ${missing.join(", ")}`);
        }
        for (const task of tasks) {
            if (taskNumbers.includes(task.taskNumber)) appendFiles(task, paths);
        }

        const argumentsPath = resolveRunArgumentsPath(authoritativeRoot);
        let snapshot: RunArgumentsSnapshot | null = null;
        if (existsSync(argumentsPath)) {
            snapshot = JSON.parse(readFileSync(argumentsPath, "utf8")) as RunArgumentsSnapshot;
            refreshRunArgumentsSnapshotInMemory(snapshot, tasks);
        }

        writeJsonAtomically(pair.tasksPath, tasks);
        if (snapshot) writeJsonAtomically(argumentsPath, snapshot);
        return tasks;
    }, { onAcquired });
}

function runAsCli(): void {
    const sourceRoot = process.cwd();
    const argv = process.argv.slice(2);
    const numbers = leadingTaskNumbers(argv);
    const paths = argv.slice(1);
    try {
        addTaskFiles(numbers, paths, sourceRoot);
    } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
