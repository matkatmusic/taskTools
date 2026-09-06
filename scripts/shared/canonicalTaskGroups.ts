// Groups tasks by canonical ownership-key overlap so occurrence aliases and ancestor-gitlink effects union correctly, unlike taskGroups.ts's raw declared-path grouping.
import type { TaskRecord } from "./taskFiles.ts";
import type { TaskGroup } from "./taskGroups.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { RepositoryManifest } from "./repositoryManifest.ts";
import { computeCanonicalOwnershipKey, expandTaskPathEffects, type OwnershipKey } from "./ownershipKeys.ts";

function keyString(key: OwnershipKey): string {
    return JSON.stringify(key);
}

function canonicalKeysForTask(task: TaskRecord, manifest: RepositoryManifest): Set<string> {
    const keys = new Set<string>();
    for (const file of declaredFiles(task)) {
        const effects = expandTaskPathEffects(file, manifest);
        keys.add(keyString(effects.key));
        for (const ancestorPath of effects.ancestorGitlinks) {
            keys.add(keyString(computeCanonicalOwnershipKey(ancestorPath, manifest)));
        }
    }
    return keys;
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

export function buildCanonicalTaskGroups(tasks: TaskRecord[], manifest: RepositoryManifest): TaskGroup[] {
    const parent = new Map<number, number>();
    for (const task of tasks) parent.set(task.taskNumber, task.taskNumber);

    const unknownTaskNumbers = tasks.filter((t) => declaredFiles(t).length === 0).map((t) => t.taskNumber);
    for (const taskNumber of unknownTaskNumbers.slice(1)) {
        union(parent, unknownTaskNumbers[0], taskNumber);
    }

    const taskKeys = new Map<number, Set<string>>();
    for (const task of tasks) taskKeys.set(task.taskNumber, canonicalKeysForTask(task, manifest));

    const lastTaskWithKey = new Map<string, number>();
    for (const task of tasks) {
        for (const key of taskKeys.get(task.taskNumber)!) {
            const owner = lastTaskWithKey.get(key);
            if (owner !== undefined) union(parent, owner, task.taskNumber);
            lastTaskWithKey.set(key, task.taskNumber);
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
        const scope = filePaths.length > 0 ? "declared" : "unknown";
        return { groupId: 0, taskNumbers, filePaths, scope } as TaskGroup;
    });

    groups.sort((a, b) => a.taskNumbers[0] - b.taskNumbers[0]);
    return groups.map((group, index) => ({ ...group, groupId: index + 1 }));
}
