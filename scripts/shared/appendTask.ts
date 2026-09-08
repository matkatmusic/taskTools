import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { readTaskFile, resolveTaskFiles, seedTaskFilesIfAbsent, type TaskRecord } from "./taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";


export type NewTaskPayload = {
    title: string;
    userDescription: string;
    goal: string[];
    notInScope: string[];
    schemaVersion: string;
    hasTests: boolean;
    tests: string;
    problemSolvedByTask?: string;
    chainGoal?: string[];
    files?: string[];
    description?: string;
    difficulty?: number;
    blockedBy?: { taskNumber: number; reason: string }[];
    handoffFilePaths?: string[];
};

export function getHeadCommitHash(projectRoot: string): string {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trimEnd();
    } catch {
        return "";
    }
}

export function buildTaskEntry(payload: NewTaskPayload, taskNumber: number, commitHash: string): TaskRecord {
    const entry: TaskRecord = { taskNumber };
    const commitHashIsUsable = /^[0-9a-f]{40}$/.test(commitHash);
    if (commitHashIsUsable) {
        entry.version = commitHash;
    }
    entry.title = payload.title;
    entry.userDescription = payload.userDescription;
    if (payload.chainGoal && payload.chainGoal.length > 0) {
        entry.chainGoal = payload.chainGoal;
    }
    entry.goal = payload.goal;
    if (!Array.isArray(payload.notInScope)) {
        throw new Error(`task ${taskNumber}: notInScope is required (an array of "- " lines)`);
    }
    entry.notInScope = payload.notInScope;
    if (payload.problemSolvedByTask) {
        entry.problemSolvedByTask = payload.problemSolvedByTask;
    }
    if (payload.description) {
        entry.description = payload.description;
    }
    // if (payload.files && payload.files.length > 0) {
    //     entry.files = payload.files;
    // }
    entry.modifiableFiles = payload.files ?? [];
    entry.readOnlyFiles = ["*"];
    entry.schemaVersion = payload.schemaVersion;
    entry.hasTests = payload.hasTests;
    entry.tests = payload.tests;
    if (payload.difficulty !== undefined) {
        entry.difficulty = payload.difficulty;
    }
    if (payload.blockedBy && payload.blockedBy.length > 0) {
        entry.blockedBy = payload.blockedBy;
    }
    if (payload.handoffFilePaths && payload.handoffFilePaths.length > 0) {
        entry.handoffFilePaths = payload.handoffFilePaths;
    }
    return entry;
}

// Pre-plugin repos keep tasks.json at the project root, so the path is resolved rather than hardcoded.
export function commitTasksJson(projectRoot: string, taskNumber: number): void {
    const tasksPath = relative(projectRoot, resolveTaskFiles(projectRoot).tasksPath);
    execFileSync("git", ["add", tasksPath], { cwd: projectRoot });
    // --only, so a session that already staged unrelated work does not get it swept into this commit.
    execFileSync("git", ["commit", "--only", tasksPath, "-m", `created task ${taskNumber}`], { cwd: projectRoot });
}

// Appends under the shared task-state lock so a concurrent closeTasks cannot overwrite or be overwritten (C86-23).
export function appendTaskToTasksJson(
    payload: NewTaskPayload,
    projectRoot: string,
    { onAcquired }: { onAcquired?: () => void } = {},
): TaskRecord {
    const pair = resolveTaskFiles(projectRoot);
    seedTaskFilesIfAbsent(pair);
    const entry = withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const usedNumbers = [...tasks, ...readTaskFile(pair.completedTasksPath)].map((task) => task.taskNumber);
        const taskNumber = Math.max(0, ...usedNumbers) + 1;
        const commitHash = getHeadCommitHash(projectRoot);
        const entry = buildTaskEntry(payload, taskNumber, commitHash);
        writeJsonAtomically(pair.tasksPath, [...tasks, entry]);
        return entry;
    }, { onAcquired });
    commitTasksJson(projectRoot, entry.taskNumber);
    return entry;
}

function readStdin(): string {
    try {
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

function fail(problem: string): never {
    process.stderr.write(
        `appendTask: ${problem}\n` +
            `usage: node appendTask.ts <<'CREATETASKEOF'\n<task payload JSON>\nCREATETASKEOF\n`,
    );
    process.exit(1);
}

if (process.argv[1]?.endsWith("appendTask.ts")) {
    const payloadText = readStdin().replace(/\n$/, "");
    if (payloadText === "") {
        fail("no payload on stdin");
    }
    const payload = JSON.parse(payloadText) as NewTaskPayload;
    const entry = appendTaskToTasksJson(payload, process.cwd());
    process.stdout.write(`${entry.taskNumber}\n`);
}
