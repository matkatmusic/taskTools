// Groups tasks by shared file paths so disjoint groups can run in parallel. No-file tasks share one "unknown" group.
import type { TaskRecord } from "./taskFiles.ts";
import { buildCanonicalTaskGroups } from "./canonicalTaskGroups.ts";
import type { RepositoryManifest } from "./repositoryManifest.ts";

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

// Manifest-free fallback for taskStats.ts: groups by exact shared file paths, files-less tasks share "unknown".
function groupTasksByExactFileOverlapWithNoManifest(tasks: TaskRecord[]): TaskGroup[] {
    const parent = new Map<number, number>();
    const find = (n: number): number => (parent.get(n) === n ? n : find(parent.set(n, find(parent.get(n)!)).get(n)!));
    const union = (a: number, b: number) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent.set(rootA, rootB);
    };
    for (const task of tasks) parent.set(task.taskNumber, task.taskNumber);

    const fileOwner = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) {
            const owner = fileOwner.get(file);
            if (owner === undefined) fileOwner.set(file, task.taskNumber);
            else union(task.taskNumber, owner);
        }
    }
    const unknownTasks = tasks.filter((task) => declaredFiles(task).length === 0);
    for (let i = 1; i < unknownTasks.length; i++) union(unknownTasks[0].taskNumber, unknownTasks[i].taskNumber);

    const componentsByRoot = new Map<number, TaskRecord[]>();
    for (const task of tasks) {
        const root = find(task.taskNumber);
        const bucket = componentsByRoot.get(root) ?? [];
        bucket.push(task);
        componentsByRoot.set(root, bucket);
    }

    const groups: TaskGroup[] = [...componentsByRoot.values()].map((members) => {
        const taskNumbers = members.map((m) => m.taskNumber).sort((a, b) => a - b);
        const filePaths = [...new Set(members.flatMap((m) => declaredFiles(m)))].sort();
        const scope: TaskGroupScope = filePaths.length > 0 ? "declared" : "unknown";
        return { groupId: 0, taskNumbers, filePaths, scope };
    });
    groups.sort((a, b) => a.taskNumbers[0] - b.taskNumbers[0]);
    return groups.map((group, index) => ({ ...group, groupId: index + 1 }));
}

export function groupTasksByFileOverlap(tasks: TaskRecord[], manifest?: RepositoryManifest): TaskGroup[] {
    if (manifest === undefined) return groupTasksByExactFileOverlapWithNoManifest(tasks);
    return buildCanonicalTaskGroups(tasks, manifest);
}
