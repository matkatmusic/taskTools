// Groups tasks by shared file paths so disjoint groups can run in parallel. No-file tasks share one "unknown" group.
import type { TaskRecord } from "./taskFiles.ts";

export type TaskGroupScope = "declared" | "unknown";

export type TaskGroup = {
    groupId: number;
    taskNumbers: number[];
    filePaths: string[];
    scope: TaskGroupScope;
};

export function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

function findRoot(parent: Map<number, number>, taskNumber: number): number {
    let root = taskNumber;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
}

function union(parent: Map<number, number>, a: number, b: number): void {
    const rootA = findRoot(parent, a);
    const rootB = findRoot(parent, b);
    if (rootA !== rootB) parent.set(rootA, rootB);
}

export function groupTasksByFileOverlap(tasks: TaskRecord[]): TaskGroup[] {
    const parent = new Map<number, number>();
    for (const task of tasks) parent.set(task.taskNumber, task.taskNumber);

    const unknownTaskNumbers = tasks.filter((t) => declaredFiles(t).length === 0).map((t) => t.taskNumber);
    for (const taskNumber of unknownTaskNumbers.slice(1)) {
        union(parent, unknownTaskNumbers[0], taskNumber);
    }

    const lastTaskWithFile = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) {
            const owner = lastTaskWithFile.get(file);
            if (owner !== undefined) union(parent, owner, task.taskNumber);
            lastTaskWithFile.set(file, task.taskNumber);
        }
    }

    const byRoot = new Map<number, TaskRecord[]>();
    for (const task of tasks) {
        const root = findRoot(parent, task.taskNumber);
        const bucket = byRoot.get(root) ?? [];
        bucket.push(task);
        byRoot.set(root, bucket);
    }

    const groups: TaskGroup[] = [...byRoot.values()].map((groupTasks) => {
        const taskNumbers = groupTasks.map((t) => t.taskNumber).sort((a, b) => a - b);
        const filePaths = [...new Set(groupTasks.flatMap(declaredFiles))].sort();
        const scope: TaskGroupScope = filePaths.length > 0 ? "declared" : "unknown";
        return { groupId: 0, taskNumbers, filePaths, scope };
    });

    groups.sort((a, b) => a.taskNumbers[0] - b.taskNumbers[0]);
    return groups.map((group, index) => ({ ...group, groupId: index + 1 }));
}
