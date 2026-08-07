// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { writeFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";

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

function runAsCli(): void {
    const repoRoot = process.cwd();
    const argv = process.argv.slice(2);
    const numbers = leadingTaskNumbers(argv);
    const paths = argv.slice(1);
    const rejected = firstRejectedPath(paths);
    if (rejected) {
        process.stderr.write(`addTaskFiles: rejected ${rejected}\n`);
        process.exit(1);
    }
    const pair = resolveTaskFiles(repoRoot);
    const tasks = readTaskFile(pair.tasksPath);
    const taskNumbers = new Set(tasks.map((task) => task.taskNumber));
    const missing = numbers.filter((number) => !taskNumbers.has(number));
    if (missing.length > 0) {
        process.stderr.write(`addTaskFiles: not found in tasks.json: ${missing.join(", ")}\n`);
        process.exit(1);
    }
    for (const task of tasks) {
        if (numbers.includes(task.taskNumber)) appendFiles(task, paths);
    }
    writeFileSync(pair.tasksPath, JSON.stringify(tasks, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
