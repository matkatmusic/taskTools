import { findTask, readTaskLists } from "./getTaskDetails.ts";
import { closeTasks, type CloseTasksResult } from "./closeTasks.ts";
import type { TaskRecord } from "./taskFiles.ts";

function isOpenTask(taskNumber: number, projectRoot?: string): boolean {
    const { openTasks } = readTaskLists(projectRoot);
    return openTasks.some((task) => task.taskNumber === taskNumber);
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
    if (!isOpenTask(taskNumber, projectRoot)) {
        throw new Error(`Task ${taskNumber} is already closed and cannot be split`);
    }
    return parent;
}

export function partitionFiles(files: string[], numSplits: number): string[][] {
    assertValidSplitCount(numSplits);
    if (files.length < numSplits) {
        throw new Error(`Cannot split into ${numSplits} groups: parent has only ${files.length} file(s)`);
    }
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

    const assignedTwice = [...new Set(flattened.filter((file, index) => flattened.indexOf(file) !== index))];
    if (assignedTwice.length > 0) {
        problems.push(`File(s) assigned to more than one child: ${assignedTwice.join(", ")}`);
    }

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
        if (!isOpenTask(child, projectRoot)) {
            throw new Error(`Child task ${child} is not an open task`);
        }
    }
}

export function verifyChildFiles(childNumber: number, expectedFiles: string[], projectRoot?: string): void {
    const child = findTask(childNumber, projectRoot);
    if (!child) {
        throw new Error(`Child task ${childNumber} not found`);
    }
    const actual = (child.files as string[] | undefined) ?? [];
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
    projectRoot?: string,
): CloseTasksResult {
    const parent = readParentTask(parentNumber, projectRoot);
    validateChildNumbers(childNumbers, numSplits, parentNumber, projectRoot);
    const fileGroups = partitionFiles((parent.files as string[] | undefined) ?? [], numSplits);
    validateFileGroups(parent.files as string[] | undefined, fileGroups);
    childNumbers.forEach((childNumber, index) => verifyChildFiles(childNumber, fileGroups[index], projectRoot));

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

function runInfo(taskNumberArg: string, numSplitsArg: string): void {
    const taskNumber = toPositiveInt(taskNumberArg, "taskNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const parent = readParentTask(taskNumber);
    const fileGroups = partitionFiles((parent.files as string[] | undefined) ?? [], numSplits);
    console.log(JSON.stringify({ parent, fileGroups }, null, 2));
}

function runClose(parentNumberArg: string, numSplitsArg: string, childNumbersArg: string): void {
    const parentNumber = toPositiveInt(parentNumberArg, "parentNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const childNumbers = (childNumbersArg ?? "").split(",").map((raw) => toPositiveInt(raw.trim(), "childNumber"));
    const result = closeParentTask(parentNumber, numSplits, childNumbers);
    console.log(JSON.stringify(result, null, 2));
}

function main(): void {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "info") {
        runInfo(rest[0], rest[1]);
        return;
    }
    if (command === "close") {
        runClose(rest[0], rest[1], rest[2]);
        return;
    }
    console.error(
        "Usage: splitTask.ts info <taskNum> <numSplits> | splitTask.ts close <parentNum> <numSplits> <childNum1,childNum2,...>",
    );
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main();
}
