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

export function groupTasksByFileOverlap(tasks: TaskRecord[], manifest: RepositoryManifest): TaskGroup[] {
    return buildCanonicalTaskGroups(tasks, manifest);
}
