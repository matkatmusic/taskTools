// Archives fully-published tasks from an explicit list; task 31's approvalGate.ts already gates this, so no re-prompt.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

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
): { archived: number[]; leftOpen: number[] } {
    const resultsByTask = new Map(mergeResults.map((result) => [result.taskNumber, result]));
    const considered = new Set<number>([...publishedTaskNumbers, ...mergeResults.map((result) => result.taskNumber)]);

    const archived: number[] = [];
    for (const taskNumber of new Set(publishedTaskNumbers)) {
        if (resultsByTask.get(taskNumber)?.fullyPublished) archived.push(taskNumber);
    }
    const leftOpen = [...considered].filter((taskNumber) => !archived.includes(taskNumber));

    if (archived.length > 0) {
        const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
        const tasks = readTaskFile(tasksPath);
        const completedTasks = readTaskFile(completedTasksPath);
        const completionDate = new Date().toISOString().slice(0, 10);
        for (const taskNumber of archived) {
            const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
            if (index === -1) continue;
            const [task] = tasks.splice(index, 1);
            const commitHashes = (resultsByTask.get(taskNumber)?.repos ?? [])
                .filter((repo) => repo.status === "published" && repo.commitHash)
                .map((repo) => repo.commitHash as string);
            completedTasks.push({ ...task, completionDate, commitHashes });
        }
        writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
        writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
    }

    return { archived, leftOpen };
}
