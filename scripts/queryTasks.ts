// Answers "what blocks task N" and "which open tasks touch file X" from tasks.json, no agent, no database.
import { readTaskLists } from "./getTaskDetails.ts";
import type { TaskRecord } from "./taskFiles.ts";

export type Blocker = { taskNumber: number; title: string; reason: string };

// Walks the blockedBy chain from `taskNumber`, across open and completed tasks (a blocker can be closed).
export function blockerChain(taskNumber: number, projectRoot: string = process.cwd()): Blocker[] {
    const { openTasks, completedTasks } = readTaskLists(projectRoot);
    const allTasks = new Map<number, TaskRecord>();
    for (const task of completedTasks) allTasks.set(task.taskNumber, task);
    for (const task of openTasks) allTasks.set(task.taskNumber, task);

    const blockedByOf = (task: TaskRecord | undefined): { taskNumber: number; reason: string }[] =>
        Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNumber: number; reason: string }[]) : [];

    const results: Blocker[] = [];
    const visited = new Set<number>([taskNumber]);
    const queue = [...blockedByOf(allTasks.get(taskNumber))];
    while (queue.length > 0) {
        const next = queue.shift()!;
        if (visited.has(next.taskNumber)) continue;
        visited.add(next.taskNumber);
        const task = allTasks.get(next.taskNumber);
        results.push({ taskNumber: next.taskNumber, title: task?.title ?? "(unknown)", reason: next.reason });
        queue.push(...blockedByOf(task));
    }
    return results;
}

// Open tasks whose modifiableFiles contains `filePath`.
export function tasksTouchingFile(filePath: string, projectRoot: string = process.cwd()): TaskRecord[] {
    const { openTasks } = readTaskLists(projectRoot);
    return openTasks.filter(task => Array.isArray(task.modifiableFiles) && (task.modifiableFiles as string[]).includes(filePath));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    const [command, arg] = process.argv.slice(2);
    if (command === "blockers" && arg) {
        const blockers = blockerChain(Number(arg));
        process.stdout.write(blockers.map(b => `${b.taskNumber}: ${b.title} (${b.reason})`).join("\n") + (blockers.length > 0 ? "\n" : ""));
    } else if (command === "files" && arg) {
        const tasks = tasksTouchingFile(arg);
        process.stdout.write(tasks.map(t => `${t.taskNumber}: ${t.title}`).join("\n") + (tasks.length > 0 ? "\n" : ""));
    } else {
        process.stderr.write("usage: node queryTasks.ts blockers <taskNumber> | files <path>\n");
        process.exit(1);
    }
}
