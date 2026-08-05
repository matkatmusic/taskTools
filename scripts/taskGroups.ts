// Groups tasks by shared file paths so disjoint groups can run in parallel. No-file tasks share one "unknown" group.
import type { TaskRecord } from "./taskFiles.ts";
import { buildCanonicalTaskGroups } from "./canonicalTaskGroups.ts";
import { REPOSITORY_MANIFEST_VERSION } from "./repositoryManifest.ts";
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

// No disk-free manifest constructor exists yet, so build a one-occurrence root manifest inline.
function buildFlatSingleRepositoryManifest(): RepositoryManifest {
    return {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            {
                occurrenceId: "flat",
                checkoutPath: "",
                parentOccurrenceId: null,
                pathInParent: null,
                gitlinkOid: null,
                depth: 0,
                originUrl: "https://local/flat/flat.git",
                baseBranch: "main",
                baseOid: "0".repeat(40),
                operationBranch: "main",
                childOccurrenceIds: [],
                testState: "untested",
            },
        ],
    };
}

export function groupTasksByFileOverlap(tasks: TaskRecord[]): TaskGroup[] {
    return buildCanonicalTaskGroups(tasks, buildFlatSingleRepositoryManifest());
}
