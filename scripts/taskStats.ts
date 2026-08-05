// Aggregates tasks.json and completedTasks.json: closure velocity, files coverage, blocking, and the parallelism a tackle-tasks run would get.
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { declaredFiles, groupTasksByFileOverlap } from "./taskGroups.ts";
import { bootstrapRepositoryManifest } from "./manifestBootstrap.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";

const FLAT_OCCURRENCE: RepositoryOccurrence = {
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
};

export type TaskStats = {
    openCount: number;
    blockedCount: number;
    unblockedCount: number;
    openWithFiles: number;
    openWithoutFiles: number;
    completedCount: number;
    completedWithCommitHashes: number;
    closedLast7: number;
    closedLast30: number;
    busiestDay: { date: string; count: number } | null;
    forecastTaskCount: number;
    groupCount: number;
    largestGroupSize: number;
    contendedFiles: { path: string; taskCount: number }[];
};

const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);

function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return blockedBy.map(Number).filter(n => openNumbers.has(n));
}

function countClosedWithin(completed: TaskRecord[], today: string, days: number): number {
    const cutoff = dayNumber(today) - days + 1;
    return completed.filter(t => {
        const date = typeof t.completionDate === "string" ? t.completionDate : "";
        return date !== "" && dayNumber(date) >= cutoff && dayNumber(date) <= dayNumber(today);
    }).length;
}

function findBusiestDay(completed: TaskRecord[]): { date: string; count: number } | null {
    const perDay = new Map<string, number>();
    for (const task of completed) {
        if (typeof task.completionDate !== "string") continue;
        perDay.set(task.completionDate, (perDay.get(task.completionDate) ?? 0) + 1);
    }
    const ranked = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return ranked.length > 0 ? { date: ranked[0][0], count: ranked[0][1] } : null;
}

function rankContendedFiles(tasks: TaskRecord[]): { path: string; taskCount: number }[] {
    const perFile = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    return [...perFile.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([path, taskCount]) => ({ path, taskCount }));
}

export function computeTaskStats(
    open: TaskRecord[],
    completed: TaskRecord[],
    today: string,
    manifest: RepositoryManifest,
): TaskStats {
    const openNumbers = new Set(open.map(t => t.taskNumber));
    const unblocked = open.filter(t => openBlockersOf(t, openNumbers).length === 0);
    // tackle-tasks refuses blocked tasks and tasks declaring no files, so the forecast uses the same gate.
    const forecastable = unblocked.filter(t => declaredFiles(t).length > 0);
    const groups = forecastable.length > 0 ? groupTasksByFileOverlap(forecastable, manifest) : [];

    return {
        openCount: open.length,
        blockedCount: open.length - unblocked.length,
        unblockedCount: unblocked.length,
        openWithFiles: open.filter(t => declaredFiles(t).length > 0).length,
        openWithoutFiles: open.filter(t => declaredFiles(t).length === 0).length,
        completedCount: completed.length,
        completedWithCommitHashes: completed.filter(t => Array.isArray(t.commitHashes) && t.commitHashes.length > 0).length,
        closedLast7: countClosedWithin(completed, today, 7),
        closedLast30: countClosedWithin(completed, today, 30),
        busiestDay: findBusiestDay(completed),
        forecastTaskCount: forecastable.length,
        groupCount: groups.length,
        largestGroupSize: groups.reduce((n, g) => Math.max(n, g.taskNumbers.length), 0),
        contendedFiles: rankContendedFiles(open),
    };
}

export function formatTaskStats(stats: TaskStats): string {
    const lines = [
        `${stats.openCount} open (${stats.unblockedCount} unblocked, ${stats.blockedCount} blocked)`,
        `${stats.openWithFiles} of ${stats.openCount} open tasks declare files — ${stats.openWithoutFiles} would be refused by tackle-tasks`,
        `${stats.completedCount} completed, ${stats.completedWithCommitHashes} with commit hashes recorded`,
        `closed: ${stats.closedLast7} in the last 7 days, ${stats.closedLast30} in the last 30`,
    ];
    if (stats.busiestDay) lines.push(`busiest day: ${stats.busiestDay.date} (${stats.busiestDay.count} closed)`);
    lines.push(
        stats.forecastTaskCount > 0
            ? `parallelism: ${stats.forecastTaskCount} runnable tasks would form ${stats.groupCount} groups, largest ${stats.largestGroupSize} tasks (serialized within a group)`
            : `parallelism: no runnable tasks — nothing to group`,
    );
    if (stats.contendedFiles.length > 0) {
        lines.push("contended files (each shared task serializes):");
        for (const file of stats.contendedFiles) lines.push(`  ${file.path} — ${file.taskCount} tasks`);
    }
    return lines.join("\n") + "\n";
}

// Stats must work outside a discoverable repo, so an undiscoverable root forecasts as one flat repository.
function manifestForForecast(repoRoot: string): RepositoryManifest {
    try {
        const bootstrap = bootstrapRepositoryManifest(repoRoot);
        if (!bootstrap.refused) return { version: REPOSITORY_MANIFEST_VERSION, occurrences: bootstrap.occurrenceGraph };
    } catch {
        // not a git checkout, or not on a branch — fall through to the flat forecast
    }
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: [FLAT_OCCURRENCE] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const today = new Date().toISOString().slice(0, 10);
    const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today, manifestForForecast(repoRoot));
    process.stdout.write(formatTaskStats(stats));
}
