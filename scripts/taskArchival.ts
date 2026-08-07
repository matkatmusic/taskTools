// Archives fully-published tasks from an explicit list; task 31's approvalGate.ts already gates this, so no re-prompt.
import { readFileSync, writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";

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
    writeFile: (path: string, data: string) => void = writeFileSync,
): { archived: number[]; leftOpen: number[] } {
    const resultsByTask = new Map(mergeResults.map((result) => [result.taskNumber, result]));
    const considered = new Set<number>([...publishedTaskNumbers, ...mergeResults.map((result) => result.taskNumber)]);

    const candidates: number[] = [];
    for (const taskNumber of new Set(publishedTaskNumbers)) {
        if (resultsByTask.get(taskNumber)?.fullyPublished) candidates.push(taskNumber);
    }

    let archived: number[] = [];
    if (candidates.length > 0) {
        const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
        const originalTasksRaw = readFileSync(tasksPath, "utf8");
        const originalCompletedRaw = readFileSync(completedTasksPath, "utf8");
        const tasks = readTaskFile(tasksPath);
        const completedTasks = readTaskFile(completedTasksPath);
        const completionDate = new Date().toISOString().slice(0, 10);

        // Preflight every candidate before mutating either file: one invalid candidate blocks the whole batch, not just itself.
        const toArchive: { index: number; task: TaskRecord; commitHashes: string[] }[] = [];
        for (const taskNumber of candidates) {
            const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
            if (index === -1) throw new Error(`archivePublishedTasks: task ${taskNumber} is fully published but missing from tasks.json`);
            const declaredFiles = (tasks[index].files as string[] | undefined) ?? [];
            if (declaredFiles.length === 0) throw new Error(`archivePublishedTasks: task ${taskNumber} declares no files; refusing to archive`);
            const commitHashes = resultsByTask.get(taskNumber)!.repos
                .filter((repo) => repo.status === "published" && repo.commitHash)
                .map((repo) => repo.commitHash as string);
            if (commitHashes.length === 0) throw new Error(`archivePublishedTasks: task ${taskNumber} has no usable commit hash; refusing to archive`);
            toArchive.push({ index, task: tasks[index], commitHashes });
        }

        for (const { index } of [...toArchive].sort((a, b) => b.index - a.index)) tasks.splice(index, 1);
        for (const { task, commitHashes } of toArchive) completedTasks.push({ ...task, completionDate, commitHashes });
        archived = toArchive.map(({ task }) => task.taskNumber);

        // ponytail: unreachable given the loop above always pushes one entry per candidate; kept as the explicit post-write invariant the reviewer asked for, so a future change to the preflight loop that reintroduces a silent skip fails loudly here instead of writing a partial archive.
        const stillOpen = candidates.filter((taskNumber) => !archived.includes(taskNumber));
        if (stillOpen.length > 0) throw new Error(`archivePublishedTasks: candidates left unarchived: ${stillOpen.join(", ")}`);

        // Serialize both final versions before touching disk, so a mid-write failure has a known-good pair to restore.
        const serializedTasks = JSON.stringify(tasks, null, 2) + "\n";
        const serializedCompleted = JSON.stringify(completedTasks, null, 2) + "\n";
        try {
            writeFile(tasksPath, serializedTasks);
            writeFile(completedTasksPath, serializedCompleted);
        } catch (writeError) {
            const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
            try {
                writeFile(tasksPath, originalTasksRaw);
                writeFile(completedTasksPath, originalCompletedRaw);
            } catch (rollbackError) {
                const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new Error(`archivePublishedTasks: write failed (${writeMessage}) and rollback also failed (${rollbackMessage}); tasks.json/completedTasks.json may be inconsistent`);
            }
            throw new Error(`archivePublishedTasks: write failed and was rolled back to the original files: ${writeMessage}`);
        }
    }

    const leftOpen = [...considered].filter((taskNumber) => !archived.includes(taskNumber));
    return { archived, leftOpen };
}
