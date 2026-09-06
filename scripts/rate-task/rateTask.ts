// Scores difficulty and split-worthiness (1-10), persists both, and lists split points for /split-task.
import { writeFileSync } from "node:fs";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "../shared/taskFiles.ts";
import { declaredFiles } from "../shared/taskGroups.ts";
import { readTaskLists } from "../shared/getTaskDetails.ts";
import { PATH_IS_NOT_TEST_FILE, PATH_IS_TEST_FILE } from "../shared/resultCodes.ts";

export type RatingResult = {
    taskNumber: number;
    difficulty: number;
    splitWorthiness: number;
    splitPoints: string[];
};

const SPLIT_POINT_THRESHOLD = 5;

function clampScore(raw: number): number {
    return Math.min(10, Math.max(1, Math.round(raw)));
}

function isTestFile(path: string): number {
    const matches = /(^|\/)tests?\//i.test(path) || /\.test\.[jt]sx?$/i.test(path);
    return matches ? PATH_IS_TEST_FILE : PATH_IS_NOT_TEST_FILE;
}

function enumeratedLines(description: string): string[] {
    const seen = new Set<string>();
    const points: string[] = [];
    for (const line of description.split("\n")) {
        const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
        if (!match) continue;
        const text = match[1].trim();
        if (seen.has(text)) continue;
        seen.add(text);
        points.push(text);
    }
    return points;
}

function groupFilesByTopLevelDirectory(files: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const file of files) {
        const top = file.split("/")[0];
        const group = grouped.get(top) ?? [];
        group.push(file);
        grouped.set(top, group);
    }
    return grouped;
}

export function scoreDifficulty(task: TaskRecord): number {
    const files = declaredFiles(task);
    const nonTestFiles = files.filter((f) => isTestFile(f) !== PATH_IS_TEST_FILE);
    const testFiles = files.filter((f) => isTestFile(f) === PATH_IS_TEST_FILE);
    const subsystemCount = groupFilesByTopLevelDirectory(files).size;
    const enumeratedSteps = enumeratedLines(task.description ?? "").length;

    if (files.length === 0) return 1;
    if (nonTestFiles.length === 1 && testFiles.length === 0 && enumeratedSteps === 0) return 2;
    if (nonTestFiles.length === 1 && testFiles.length >= 1 && enumeratedSteps === 0) return 4;
    if (subsystemCount <= 1 && enumeratedSteps <= 1) return files.length <= 4 ? 5 : 6;
    if (subsystemCount <= 1) return Math.min(8, 6 + Math.ceil(enumeratedSteps / 2));
    if (subsystemCount === 2) return 7;
    if (subsystemCount >= 4 || files.length >= 8) return 10;
    return enumeratedSteps >= 3 ? 9 : 8;
}

export function buildSplitPoints(task: TaskRecord): string[] {
    const files = declaredFiles(task);
    if (files.length < 2) return [];
    const lines = enumeratedLines(task.description ?? "");
    if (lines.length >= 2) return lines;
    const grouped = groupFilesByTopLevelDirectory(files);
    const dirs = [...grouped.keys()];
    return dirs.length >= 2 ? dirs.map((dir) => `${dir}: ${grouped.get(dir)!.join(", ")}`) : [];
}

export function scoreSplitWorthiness(task: TaskRecord, points: string[]): number {
    if (points.length < 2) return clampScore(Math.min(4, points.length * 2 + 1));
    const subsystemCount = groupFilesByTopLevelDirectory(declaredFiles(task)).size;
    const enumeratedStepCount = enumeratedLines(task.description ?? "").length;
    return clampScore(
        SPLIT_POINT_THRESHOLD +
            Math.max(0, points.length - 2) +
            Math.max(0, subsystemCount - 1) +
            Math.max(0, enumeratedStepCount - points.length),
    );
}

export function rateTask(task: TaskRecord): RatingResult {
    const difficulty = scoreDifficulty(task);
    const points = buildSplitPoints(task);
    const splitWorthiness = scoreSplitWorthiness(task, points);
    const splitPoints = splitWorthiness >= SPLIT_POINT_THRESHOLD ? points : [];
    return { taskNumber: task.taskNumber, difficulty, splitWorthiness, splitPoints };
}

export function rateAndPersist(projectRoot: string, taskNumbers: number[]): RatingResult[] {
    const { openTasks } = readTaskLists(projectRoot);
    const openByNumber = new Map(openTasks.map((task) => [task.taskNumber, task]));
    const targets = taskNumbers.length === 0
        ? openTasks
        : taskNumbers.map((number) => {
            const task = openByNumber.get(number);
            if (!task) throw new Error(`not open in tasks.json: ${number}`);
            return task;
        });
    const results = targets.map(rateTask);

    const pair = resolveTaskFiles(projectRoot);
    const tasks = readTaskFile(pair.tasksPath);
    const taskByNumber = new Map(tasks.map((task) => [task.taskNumber, task]));
    for (const result of results) {
        const task = taskByNumber.get(result.taskNumber)!;
        task.difficulty = result.difficulty;
        task.splitWorthiness = result.splitWorthiness;
    }
    writeFileSync(pair.tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    return results;
}

export function formatReport(results: RatingResult[]): string {
    return results.map((result) => {
        const lines = [`task ${result.taskNumber}: difficulty ${result.difficulty}/10, split-worthiness ${result.splitWorthiness}/10`];
        if (result.splitPoints.length > 0) {
            lines.push(`  /split-task ${result.taskNumber} ${result.splitPoints.length} ${result.splitPoints.join(" | ")}`);
            for (const point of result.splitPoints) lines.push(`  - ${point}`);
        }
        return lines.join("\n");
    }).join("\n");
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const numbers = leadingTaskNumbers(process.argv.slice(2));
    let results: RatingResult[];
    try {
        results = rateAndPersist(repoRoot, numbers);
    } catch (error) {
        process.stderr.write(`rateTask: ${(error as Error).message}\n`);
        process.exit(1);
    }
    process.stdout.write(formatReport(results) + "\n");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
