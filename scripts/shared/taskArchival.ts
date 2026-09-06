// Archives fully-published tasks from an explicit list; task 31's approvalGate.ts already gates this, so no re-prompt.
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { modifiableFiles } from "./prepareTasks.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

export type RepoPublishStatus = "published" | "conflicted" | "skipped" | "rolled-back";

export interface RepoPublishResult {
    repoName: string;
    status: RepoPublishStatus;
    commitHash?: string;
}

export interface TaskMergeResult {
    taskNumber: number;
    repos: RepoPublishResult[];
    fullyPublished: boolean;
}

export type RawTaskRepoOutcome = {
    taskNumber: number;
    repo: RepoPublishResult;
};

export type ArchiveRequest = { publishedTaskNumbers: number[]; mergeResults: TaskMergeResult[] };

export function summarizeTaskMergeResults(rawOutcomes: RawTaskRepoOutcome[]): TaskMergeResult[] {
    const reposByTask = new Map<number, RepoPublishResult[]>();
    for (const outcome of rawOutcomes) {
        const repos = reposByTask.get(outcome.taskNumber) ?? [];
        repos.push(outcome.repo);
        reposByTask.set(outcome.taskNumber, repos);
    }
    return [...reposByTask.entries()].map(([taskNumber, repos]) => ({
        taskNumber,
        repos,
        fullyPublished: repos.length > 0 && repos.every((repo) => repo.status === "published"),
    }));
}

export function archivePublishedTasks(
    publishedTaskNumbers: number[],
    mergeResults: TaskMergeResult[],
    projectRoot: string = process.cwd(),
    writeJson: (path: string, value: unknown) => void = writeJsonAtomically,
): { archived: number[]; leftOpen: number[] } {
    const pair = resolveTaskFiles(projectRoot);
    const resultsByTask = new Map(mergeResults.map((result) => [result.taskNumber, result]));
    const considered = new Set<number>([...publishedTaskNumbers, ...mergeResults.map((result) => result.taskNumber)]);

    const candidates: number[] = [];
    for (const taskNumber of new Set(publishedTaskNumbers)) {
        if (resultsByTask.get(taskNumber)?.fullyPublished) candidates.push(taskNumber);
    }

    let archived: number[] = [];
    if (candidates.length > 0) {
      archived = withTaskStateLock(pair.tasksPath, (): number[] => {
        const tasks = readTaskFile(pair.tasksPath);
        const completedTasks = readTaskFile(pair.completedTasksPath);
        const completionDate = new Date().toISOString().slice(0, 10);

        // Preflight every candidate before mutating either file: one invalid candidate blocks the whole batch, not just itself.
        const toArchive: { index: number; task: TaskRecord; commitHashes: string[] }[] = [];
        for (const taskNumber of candidates) {
            const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
            if (index === -1) throw new Error(`archivePublishedTasks: task ${taskNumber} is fully published but missing from tasks.json`);
            const declaredFiles = modifiableFiles(tasks[index]);
            if (declaredFiles.length === 0) throw new Error(`archivePublishedTasks: task ${taskNumber} declares no files; refusing to archive`);
            const commitHashes = resultsByTask.get(taskNumber)!.repos
                .filter((repo) => repo.status === "published" && repo.commitHash)
                .map((repo) => repo.commitHash as string);
            if (commitHashes.length === 0) throw new Error(`archivePublishedTasks: task ${taskNumber} has no usable commit hash; refusing to archive`);
            toArchive.push({ index, task: tasks[index], commitHashes });
        }

        // Archive-first, keyed by taskNumber: a retry after a partial prior write overwrites, not duplicates, the record.
        for (const { task, commitHashes } of toArchive) {
            const record = { ...task, completionDate, commitHashes };
            const existing = completedTasks.findIndex((entry) => entry.taskNumber === task.taskNumber);
            if (existing === -1) completedTasks.push(record);
            else completedTasks[existing] = record;
        }
        for (const { index } of [...toArchive].sort((a, b) => b.index - a.index)) tasks.splice(index, 1);
        const archivedLocal = toArchive.map(({ task }) => task.taskNumber);

        // Archive-first order: a failed second write leaves a safely retryable partial state.
        writeJson(pair.completedTasksPath, completedTasks);
        writeJson(pair.tasksPath, tasks);
        return archivedLocal;
      });
    }

    const leftOpen = [...considered].filter((taskNumber) => !archived.includes(taskNumber));
    return { archived, leftOpen };
}
