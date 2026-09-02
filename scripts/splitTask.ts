import { findTask, readTaskLists } from "./getTaskDetails.ts";
import { closeTasks, type CloseTasksResult } from "./closeTasks.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { TASK_IS_NOT_OPEN, TASK_IS_OPEN } from "./resultCodes.ts";
import { modifiableFiles } from "./prepareTasks.ts";

function isOpenTask(taskNumber: number, projectRoot?: string): number {
    const { openTasks } = readTaskLists(projectRoot);
    return openTasks.some((task) => task.taskNumber === taskNumber) ? TASK_IS_OPEN : TASK_IS_NOT_OPEN;
}

function assertValidSplitCount(numSplits: number): void {
    if (!Number.isInteger(numSplits) || numSplits < 2) {
        throw new Error(`numSplits must be an integer >= 2, got ${numSplits}`);
    }
}

export function readParentTask(taskNumber: number, projectRoot?: string): TaskRecord {
    const parent = findTask(taskNumber, projectRoot);
    if (!parent) {
        throw new Error(`Task ${taskNumber} not found`);
    }
    if (isOpenTask(taskNumber, projectRoot) !== TASK_IS_OPEN) {
        throw new Error(`Task ${taskNumber} is already closed and cannot be split`);
    }
    return parent;
}

export interface SplitCandidate {
    taskNumber: number;
    title: string;
    difficulty: number | undefined;
    fileCount: number;
    unsplittable: boolean;
}

export function findSplitCandidates(projectRoot?: string): SplitCandidate[] {
    const { openTasks } = readTaskLists(projectRoot);
    const candidates: SplitCandidate[] = [];
    for (const task of openTasks) {
        const record = task as unknown as Record<string, unknown>;
        const difficulty = record.difficulty as number | undefined;
        const fileCount = modifiableFiles(task).length;
        if ((difficulty ?? 0) >= 3 || fileCount > 3) {
            candidates.push({
                taskNumber: task.taskNumber,
                title: record.title as string,
                difficulty,
                fileCount,
                unsplittable: fileCount < 2,
            });
        }
    }
    return candidates.sort((a, b) => a.taskNumber - b.taskNumber);
}

export function partitionFiles(files: string[], numSplits: number): string[][] {
    assertValidSplitCount(numSplits);
    // if (files.length < numSplits) {
    //     throw new Error(`Cannot split into ${numSplits} groups: parent has only ${files.length} file(s)`);
    // }
    const base = Math.floor(files.length / numSplits);
    const remainder = files.length % numSplits;
    const groups: string[][] = [];
    let index = 0;
    for (let i = 0; i < numSplits; i++) {
        const size = base + (i < remainder ? 1 : 0);
        groups.push(files.slice(index, index + size));
        index += size;
    }
    return groups;
}

export function validateFileGroups(parentFiles: string[] | undefined, groups: string[][]): void {
    const parentList = parentFiles ?? [];
    const flattened = groups.flat();
    const problems: string[] = [];

    // A file may now belong to more than one child (chained children edit the same file in turn).
    // const assignedTwice = [...new Set(flattened.filter((file, index) => flattened.indexOf(file) !== index))];
    // if (assignedTwice.length > 0) {
    //     problems.push(`File(s) assigned to more than one child: ${assignedTwice.join(", ")}`);
    // }

    const extra = flattened.filter((file) => !parentList.includes(file));
    if (extra.length > 0) {
        problems.push(`File(s) not in the parent's files array: ${extra.join(", ")}`);
    }

    const missing = parentList.filter((file) => !flattened.includes(file));
    if (missing.length > 0) {
        problems.push(`Parent file(s) missing from every child group: ${missing.join(", ")}`);
    }

    if (problems.length > 0) {
        throw new Error(problems.join("; "));
    }
}

export function composeClosureNote(childNumbers: number[]): string {
    return `Split into ${childNumbers.join(", ")}`;
}

export function validateChildNumbers(
    childNumbers: number[],
    numSplits: number,
    parentNumber: number,
    projectRoot?: string,
): void {
    assertValidSplitCount(numSplits);
    if (childNumbers.length !== numSplits) {
        throw new Error(`Expected ${numSplits} child task numbers, got ${childNumbers.length}`);
    }
    const seen = new Set<number>();
    for (const child of childNumbers) {
        if (!Number.isInteger(child) || child <= 0) {
            throw new Error(`Child task number "${child}" is not a positive integer`);
        }
        if (child === parentNumber) {
            throw new Error(`Child task number ${child} cannot equal the parent task number`);
        }
        if (seen.has(child)) {
            throw new Error(`Child task number ${child} was supplied more than once`);
        }
        seen.add(child);
        if (isOpenTask(child, projectRoot) !== TASK_IS_OPEN) {
            throw new Error(`Child task ${child} is not an open task`);
        }
    }
}

export function verifyChildFiles(childNumber: number, expectedFiles: string[], projectRoot?: string): void {
    const child = findTask(childNumber, projectRoot);
    if (!child) {
        throw new Error(`Child task ${childNumber} not found`);
    }
    const actual = modifiableFiles(child);
    const matches = actual.length === expectedFiles.length && actual.every((file, i) => file === expectedFiles[i]);
    if (!matches) {
        throw new Error(
            `Child task ${childNumber} files ${JSON.stringify(actual)} do not match its assigned group ${JSON.stringify(expectedFiles)}`,
        );
    }
}

export function closeParentTask(
    parentNumber: number,
    numSplits: number,
    childNumbers: number[],
    childFileGroups: string[][],
    projectRoot?: string,
): CloseTasksResult {
    const parent = readParentTask(parentNumber, projectRoot);
    validateChildNumbers(childNumbers, numSplits, parentNumber, projectRoot);
    if (childFileGroups.length !== numSplits) {
        throw new Error(`Expected ${numSplits} file group(s), got ${childFileGroups.length}`);
    }
    validateFileGroups(modifiableFiles(parent), childFileGroups);
    childNumbers.forEach((childNumber, index) => verifyChildFiles(childNumber, childFileGroups[index], projectRoot));

    const result = closeTasks([parentNumber], composeClosureNote(childNumbers), projectRoot);
    if (!result.closed.includes(parentNumber)) {
        throw new Error(`Failed to close parent task ${parentNumber}`);
    }
    return result;
}

function toPositiveInt(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer, got "${value}"`);
    }
    return parsed;
}

export function runInfo(taskNumberArg: string, numSplitsArg: string, projectRoot?: string): void {
    if (numSplitsArg === undefined) {
        throw new Error("Usage: /split-task <taskNum> <numSplits> [guidance]");
    }
    const taskNumber = toPositiveInt(taskNumberArg, "taskNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const parent = readParentTask(taskNumber, projectRoot);
    const fileGroups = partitionFiles(modifiableFiles(parent), numSplits);
    console.log(JSON.stringify({ parent, fileGroups }, null, 2));
}

export function parseFileGroups(raw: string): string[][] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`fileGroups must be valid JSON, got "${raw}"`);
    }
    if (
        !Array.isArray(parsed) ||
        !parsed.every((group) => Array.isArray(group) && group.every((file) => typeof file === "string"))
    ) {
        throw new Error(`fileGroups must be a JSON array of string arrays, got "${raw}"`);
    }
    return parsed as string[][];
}

export function runClose(
    parentNumberArg: string,
    numSplitsArg: string,
    childNumbersArg: string,
    fileGroupsArg: string,
): void {
    if (numSplitsArg === undefined) {
        throw new Error("Usage: splitTask.ts close <parentNum> <numSplits> <childNum1,childNum2,...> <fileGroupsJson>");
    }
    const parentNumber = toPositiveInt(parentNumberArg, "parentNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const childNumbers = (childNumbersArg ?? "").split(",").map((raw) => toPositiveInt(raw.trim(), "childNumber"));
    const childFileGroups = parseFileGroups(fileGroupsArg ?? "");
    const result = closeParentTask(parentNumber, numSplits, childNumbers, childFileGroups);
    console.log(JSON.stringify(result, null, 2));
}

function runCandidates(): void {
    const candidates = findSplitCandidates();
    console.log(JSON.stringify(candidates, null, 2));
}

function main(): void {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "info") {
        runInfo(rest[0], rest[1]);
        return;
    }
    if (command === "close") {
        runClose(rest[0], rest[1], rest[2], rest[3]);
        return;
    }
    if (command === "candidates") {
        runCandidates();
        return;
    }
    console.error(
        "Usage: splitTask.ts info <taskNum> <numSplits> | splitTask.ts close <parentNum> <numSplits> <childNum1,childNum2,...> <fileGroupsJson> | splitTask.ts candidates",
    );
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main();
}
