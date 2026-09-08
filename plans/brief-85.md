# Task 85: Give split-task a free-text guidance argument that drives both the child descriptions and the file split

## User request

add a 'guidance' param hint to 'split-task <taskNum> <count>', so that you can provide guidance to the agent on how to split the task.  example: 58's title has 2 jobs: split task file ownership, make briefs point at files. I would like to be able to invoke the skill as 'split-task 58 2 make splitting task-file ownership one task and making briefs point using filepaths the other task'

The split-task skill from task #65 has landed: skills/split-task/SKILL.md (28 lines), scripts/splitTask.ts (177 lines), tests/splitTask.test.ts.

**Current state.** SKILL.md:4 declares `argument-hint: "<taskNum> <numSplits>"`. Line 7 shells out to `node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $1 $2`, and line 9 restates the two positional values. The file grouping is computed entirely by `partitionFiles` (splitTask.ts:27-42), which slices the parent's `files` array into N CONTIGUOUS, near-equal chunks by position — `base = Math.floor(files.length / numSplits)`, remainder distributed to the earliest groups. SKILL.md:13 states the consequence plainly: "The file grouping itself is fixed by the command's output; the only decision here is which piece of work (child description) goes with each group." Children are then matched to groups strictly in order (lines 13, 15, 19, 25), and `closeParentTask` (splitTask.ts:115-132) recomputes the same partition and calls `verifyChildFiles` (101-113) per child, throwing unless each child's `files` array matches its positional group exactly, element for element.

**Why a guidance string alone would not work.** The user's own example asks that one child take the file-ownership work and the other the briefs-point-at-filepaths work. Those pieces of work almost certainly do not correspond to a contiguous slice of the parent's `files` array, so under today's positional partition the guidance would be unhonourable — the agent would either ignore it or produce children that `verifyChildFiles` rejects at close time. Any change that adds the argument without addressing the partition is cosmetic.

**Decision taken: guidance drives the file split too.** The agent proposes which files belong to which child based on the guidance, rather than receiving a fixed positional partition. Validation shifts from "matches the contiguous slice" to "is a valid partition of the parent's files" — which the codebase already has: `validateFileGroups` (splitTask.ts:44-67) checks exactly the three properties that matter, reporting files assigned to more than one child (49-52), files not in the parent's array (54-57), and parent files missing from every group (59-62). That function becomes the real gate; `partitionFiles` becomes a fallback for when no guidance is given, not the authority.

**Work to do:**
1. SKILL.md:4 — extend `argument-hint` to `"<taskNum> <numSplits> [guidance]"`.
2. **Argument-parsing gotcha, and the crux of the test:** the skill uses positional `$1`/`$2`. There is no rest-of-arguments positional in slash-command substitution — a bare `$3` captures only the first whitespace-delimited token, so `split-task 58 2 make splitting task-file ownership one task and ...` would silently truncate to `make`. The guidance must be recovered from `$ARGUMENTS` with the first two tokens stripped, preserving the remainder whole including internal spaces. Guidance is optional; absent guidance must leave today's behaviour byte-identical.
3. splitTask.ts — the `info` subcommand (runInfo, 142-148) currently returns `{parent, fileGroups}` with fileGroups from partitionFiles. With guidance in play it should still print the parent record and may print the positional partition as a suggested default, but must stop being the authority on grouping. Add a way for the agent's proposed grouping to be validated — extend the `close` subcommand (runClose, 150-156) to accept the per-child file lists and run `validateFileGroups` against them, instead of recomputing `partitionFiles` at line 123 and hard-comparing at 125. Preserve the failure semantics: on any validation failure the parent is NOT closed and the error names the offending child, per SKILL.md:25.
4. SKILL.md:13 must be rewritten — its "the grouping is fixed" sentence becomes false. Lines 15, 19 and 25 all lean on the strict positional ordering and need updating with it. Keep the `[split-task-child]` marker contract in line 15 exactly as-is; skills/create-task/SKILL.md checks for that literal string to bypass its oversized-task heuristic, and breaking it would make each child offer its own split and corrupt the loop's numbering.
5. Keep the partial-failure rule at SKILL.md:17 intact — if a `/create-task` invocation fails midway, stop, close nothing, and report which children exist.

**Constraint:** splitTask.ts is at 177 lines against a 250-line source cap; there is room, but not unlimited.

No blockers — #65 has landed and nothing else open declares these files.

### skills/split-task/SKILL.md

```
---
name: split-task
description: Break an oversized open task into N smaller child tasks at reasonable split points. Trigger when a task's difficulty is above 3, or its description lists many enumerated steps, and it would be clearer as several smaller tasks.
argument-hint: "<taskNum> <numSplits>"
---

- parent task and file groups: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $1 $2`

Parent task number: $1. Number of children to create: $2.

The command above printed the parent task's full record and the $2 file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $2 ways), stop here and report the error to the user instead of continuing.

Read the parent's `title`, `description`, and `userDescription`. Decide $2 reasonable split points in the parent's work — logically separable pieces of what the parent asks for — and match each split point, in order, to the file groups printed above: file group 1 becomes child 1's `files`, file group 2 becomes child 2's `files`, and so on. The file grouping itself is fixed by the command's output; the only decision here is which piece of work (child description) goes with each group.

For each of the $2 children, in order, invoke `/create-task` once with that child's description, and explicitly tell `/create-task` in that invocation, verbatim: "[split-task-child] This task is being created by `/split-task` as one of an already-requested set of $2 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `<that child's file group from the command output>`." The literal marker `[split-task-child]` at the start of that sentence is what `skills/create-task/SKILL.md` checks for to bypass its own oversized-task heuristic — every child invocation must carry it, even when a child's own difficulty would otherwise read as 4 or 5 and could trigger another split offer that would break this loop's numbering. Record the task number `create-task` reports back for each child, in the same order as the file groups printed above.

If any `/create-task` invocation fails partway through this loop, stop immediately — do not run the close command, do not retry, and do not invoke `/create-task` for the remaining split points. Report to the user which children were already created (task numbers and titles) and that the parent task ($1) is still open and was not closed, so the user can decide how to clean up the partial children.

Once all $2 children exist, run this command, replacing `<childNumbers>` with the collected child task numbers joined by commas, IN THE SAME ORDER as the file groups printed above:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" close $1 $2 <childNumbers>
```

This re-validates the child numbers, recomputes the same deterministic file groups from the parent's current `files` array, then loads each created child and checks that its actual `files` field exactly matches the group assigned to it — only if every child matches does it close the parent, moving it into `completedTasks.json` with `closureNote` set to `Split into <childNumbers>`. If this command fails — including because a child's real `files` field doesn't match its assigned group — report the error to the user and name which child mismatched; the parent was NOT closed and remains open, rather than telling the user the split succeeded.

Finally, confirm to the user: the parent task number that was closed, and the numbers and titles of the children that replaced it.

```

### scripts/splitTask.ts

```
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

```

### tests/splitTask.test.ts

```
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeParentTask,
    composeClosureNote,
    partitionFiles,
    readParentTask,
    validateChildNumbers,
    validateFileGroups,
    verifyChildFiles,
} from "../scripts/splitTask.ts";

function writeTaskFiles(root: string, tasks: unknown[], completed: unknown[]): void {
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), JSON.stringify(completed, null, 2) + "\n");
}

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "split-task-"));
    const parentTask = {
        taskNumber: 58,
        title: "Big task",
        description: "desc",
        files: ["a.ts", "b.ts", "c.ts", "d.ts"],
    };
    const childTaskA = { taskNumber: 66, title: "Child A", description: "desc", files: ["a.ts", "b.ts"] };
    const childTaskB = { taskNumber: 67, title: "Child B", description: "desc", files: ["c.ts", "d.ts"] };
    const closedTask = { taskNumber: 40, title: "Already closed", description: "desc" };
    writeTaskFiles(root, [parentTask, childTaskA, childTaskB], [closedTask]);
    return root;
}

function readTasks(root: string): any[] {
    return JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"));
}

function readCompleted(root: string): any[] {
    return JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
}

test("readParentTask loads the parent by number", () => {
    const root = makeProjectRoot();
    const parent = readParentTask(58, root);
    assert.equal(parent.taskNumber, 58);
    assert.deepEqual(parent.files, ["a.ts", "b.ts", "c.ts", "d.ts"]);
});

test("readParentTask throws when the task number does not exist", () => {
    const root = makeProjectRoot();
    assert.throws(() => readParentTask(999, root));
});

test("readParentTask throws when the task is already closed", () => {
    const root = makeProjectRoot();
    assert.throws(() => readParentTask(40, root));
});

test("partitionFiles splits contiguously into near-equal groups", () => {
    assert.deepEqual(partitionFiles(["a.ts", "b.ts", "c.ts", "d.ts"], 2), [["a.ts", "b.ts"], ["c.ts", "d.ts"]]);
    assert.deepEqual(partitionFiles(["a.ts", "b.ts", "c.ts"], 2), [["a.ts", "b.ts"], ["c.ts"]]);
});

test("partitionFiles throws when there are fewer files than splits", () => {
    assert.throws(() => partitionFiles(["a.ts"], 2));
});

test("partitionFiles throws when numSplits is less than 2", () => {
    assert.throws(() => partitionFiles(["a.ts", "b.ts"], 1));
});

test("validateFileGroups passes when groups exactly partition the parent's files", () => {
    assert.doesNotThrow(() =>
        validateFileGroups(["a.ts", "b.ts", "c.ts", "d.ts"], [["a.ts", "b.ts"], ["c.ts", "d.ts"]]),
    );
});

test("validateFileGroups throws when a parent file is missing from every group", () => {
    assert.throws(() => validateFileGroups(["a.ts", "b.ts", "c.ts"], [["a.ts"], ["b.ts"]]));
});

test("validateFileGroups throws when a group claims a file the parent doesn't have", () => {
    assert.throws(() => validateFileGroups(["a.ts", "b.ts"], [["a.ts"], ["b.ts", "z.ts"]]));
});

test("validateFileGroups throws when a file is assigned to more than one child", () => {
    assert.throws(() => validateFileGroups(["a.ts", "b.ts"], [["a.ts", "b.ts"], ["b.ts"]]));
});

test("validateFileGroups reports every violation category in one error, not just the first", () => {
    assert.throws(
        () => validateFileGroups(["a.ts", "b.ts", "c.ts"], [["a.ts", "a.ts"], ["z.ts"]]),
        (error: Error) =>
            error.message.includes("assigned to more than one child") &&
            error.message.includes("not in the parent's files array") &&
            error.message.includes("missing from every child group"),
    );
});

test("composeClosureNote formats child numbers", () => {
    assert.equal(composeClosureNote([66, 67, 68]), "Split into 66, 67, 68");
});

test("validateChildNumbers passes for the right count of distinct open children", () => {
    const root = makeProjectRoot();
    assert.doesNotThrow(() => validateChildNumbers([66, 67], 2, 58, root));
});

test("validateChildNumbers throws when the count does not match numSplits", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66], 2, 58, root));
});

test("validateChildNumbers throws on a duplicate child number", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66, 66], 2, 58, root));
});

test("validateChildNumbers throws when a child equals the parent number", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([58, 66], 2, 58, root));
});

test("validateChildNumbers throws when a child is not an open task", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66, 999], 2, 58, root));
});

test("validateChildNumbers throws when a child is already closed", () => {
    const root = makeProjectRoot();
    assert.throws(() => validateChildNumbers([66, 40], 2, 58, root));
});

test("verifyChildFiles passes when the child's files exactly match its assigned group", () => {
    const root = makeProjectRoot();
    assert.doesNotThrow(() => verifyChildFiles(66, ["a.ts", "b.ts"], root));
});

test("verifyChildFiles throws when the child's files differ from its assigned group", () => {
    const root = makeProjectRoot();
    assert.throws(() => verifyChildFiles(67, ["c.ts", "d.ts", "e.ts"], root));
});

test("closeParentTask closes the parent and moves it to completedTasks.json", () => {
    const root = makeProjectRoot();
    const result = closeParentTask(58, 2, [66, 67], root);
    assert.deepEqual(result.closed, [58]);

    const completed = readCompleted(root);
    const closedParent = completed.find((task: { taskNumber: number }) => task.taskNumber === 58);
    assert.equal(closedParent.closureNote, "Split into 66, 67");

    const open = readTasks(root).map((task: { taskNumber: number }) => task.taskNumber).sort();
    assert.deepEqual(open, [66, 67]);
});

test("closeParentTask throws and leaves the parent open when child numbers are invalid", () => {
    const root = makeProjectRoot();
    assert.throws(() => closeParentTask(58, 2, [66, 999], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("closeParentTask throws and leaves the parent open when a child omits a file from its assigned group", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts", "c.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts"] },
            { taskNumber: 67, title: "Child B", files: ["c.ts"] },
        ],
        [],
    );
    assert.throws(() => closeParentTask(58, 2, [66, 67], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("closeParentTask throws and leaves the parent open when a child claims a file outside its assigned group", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts", "z.ts"] },
            { taskNumber: 67, title: "Child B", files: ["b.ts"] },
        ],
        [],
    );
    assert.throws(() => closeParentTask(58, 2, [66, 67], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

test("closeParentTask throws and leaves the parent open when a child's files drifted from its assigned group", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts", "b.ts", "z.ts"] },
            { taskNumber: 67, title: "Child B", files: ["c.ts", "d.ts"] },
        ],
        [],
    );
    assert.throws(() => closeParentTask(58, 2, [66, 67], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});

```
