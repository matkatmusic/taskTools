# Task 65 Plan: split-task skill

Goal: a new `/split-task <taskNum> <numSplits>` skill that closes an oversized
parent task and replaces it with N child tasks created through `create-task`.
Three new files, one small edit to an existing file. No source file outside
the owned list is touched.

Core requirement (from the brief): partitioning the parent's `files` array
across N children is deterministic and lives entirely in
`scripts/splitTask.ts` — only choosing the split points (what piece of work
goes with each partition, expressed as a child description) stays agentic in
SKILL.md. The split isn't valid unless every child's *actual* `files` field —
as written to `tasks.json` by `create-task` — exactly matches the group the
script assigned to it, no more, no less, no overlap. The script checks this
for every child, after all children are created and before the parent is
closed.

## File 1 (new): `scripts/splitTask.ts`

Does not exist yet. Create it with this exact content:

```ts
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

Design notes (why, for the record — nothing here is left for the
implementer to decide):

- `readParentTask` wraps `findTask` (reference-only, not edited), throws when
  the parent doesn't exist, and separately throws when it isn't in
  `readTaskLists(...).openTasks` so an already-closed parent can't be split
  again.
- `partitionFiles(files, numSplits)` is the deterministic partitioner the
  brief requires: contiguous, near-equal-sized chunks in the parent's
  existing file order (`base = floor(len/numSplits)`, the first `remainder`
  groups get one extra file). It throws up front if there are fewer files
  than splits, so an unsplittable parent fails at `info` time rather than
  producing empty groups. There is no agent-supplied groups input anywhere
  in this file — the partition is derived solely from the parent's `files`
  array and `numSplits`.
- `validateFileGroups(parentFiles, groups)` is a defense-in-depth check run
  from `closeParentTask` immediately after `partitionFiles` computes the
  groups. Because `partitionFiles` is a total partition by construction, this
  call should never actually fail in normal operation — it exists so a
  future change to `partitionFiles` that broke the partition invariant would
  be caught immediately, not silently. It aggregates every violation
  category (file assigned twice, file not in parent's list, parent file
  missing from every group) into ONE thrown error covering all of them, not
  just the first category found — `problems.push(...)` per category, then a
  single `throw new Error(problems.join("; "))` at the end.
- `verifyChildFiles(childNumber, expectedFiles, projectRoot)` loads the child
  with `findTask` and requires the child's actual `files` array to equal
  `expectedFiles` element-for-element, in order — the exact partition group
  assigned to that child, not just an equivalent set. This is what makes
  `closeParentTask` check reality, not intent: `create-task` is instructed
  (File 3) to write the group verbatim, and this is the check that catches it
  if the agent, `create-task`, or a human editing the child afterward changed
  what actually landed in `tasks.json`.
- `composeClosureNote` is unchanged.
- `validateChildNumbers` only validates task *numbers* (count, distinctness,
  not-the-parent, currently open). It never validates files — that's
  `partitionFiles`/`validateFileGroups`/`verifyChildFiles`'s job.
- `closeParentTask` order of operations, each step throwing (and leaving
  `tasks.json`/`completedTasks.json` untouched) before the next runs:
  1. re-load and re-validate the parent (open, exists),
  2. re-validate the child numbers (count, distinct, open, not the parent),
  3. recompute the file groups via `partitionFiles` from the parent's
     current `files` array — recomputed here, not passed in, so `close`
     always checks against the parent's *live* `files` field, in case
     anything changed since `info` was run,
  4. run `validateFileGroups` as the defense-in-depth check described above,
  5. for every child, in order, `verifyChildFiles` — throws on the first
     child whose real `files` array doesn't match the group assigned to it,
  6. only if every one of the above passes does it call `closeTasks`.
  `closeTasks` is still checked against `result.closed` after the fact as a
  last-resort guard against a silent skip.
- Two CLI subcommands, not three — there is no `validate` subcommand and no
  agent-supplied groups file, because there is nothing left for an agent to
  supply: the partition is fully determined by `info`'s two arguments.
  - `info <taskNum> <numSplits>` prints `{ parent, fileGroups }` — the
    parent's full record (including `files`) plus the `numSplits` groups
    `partitionFiles` computed from it, in order. This is the only place the
    agent sees the groups; it does not choose or edit them.
  - `close <parentNum> <numSplits> <childNum1,childNum2,...>` runs after all
    children exist; it recomputes the same partition from the parent's
    current `files` field (see step 3 above) and calls `closeParentTask`.
- `toPositiveInt` / CLI argument parsing is unchanged in spirit from earlier
  drafts — same immediate-throw-with-offending-string behavior, kept separate
  from the exported functions so those stay testable without argv strings.

## File 2 (new): `tests/splitTask.test.ts`

Does not exist yet. Task 65 has no `tests` field (or it is `"skip"`) so this
is ordinary verification, not TDD — but the brief requires the round-trip
test file to exist. Use node's built-in test runner (`node:test` +
`node:assert/strict`), matching `tests/closeTasks.test.ts` and
`tests/getTaskDetails.test.ts` — not `bun:test`. Fixtures write into a
`.taskTools/` subfolder of the temp root, matching the brief's statement that
the task list lives at `.taskTools/tasks.json` (not the repo root) —
`resolveTaskFiles` finds `.taskTools/tasks.json` directly under the passed
root. Create the file with this exact content:

```ts
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

Run via `node --test "tests/**/*.test.ts"` (or targeted:
`node --test tests/splitTask.test.ts`), matching the repo's existing test
files — no `package.json` test script currently exists, so both invocation
forms are equally valid; the brief's constraint names the glob form.

## File 3 (new): `skills/split-task/SKILL.md`

Does not exist yet. No manifest edit accompanies it — this repo auto-discovers
skills from `skills/<name>/SKILL.md`, confirmed by the brief. Create the file
with this exact content:

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

`argument-hint` value is the literal string given in the brief, matching the
format of `skills/create-task/SKILL.md` line 4. The `info` step runs at
prompt-render time (same `!` pattern create-task uses for
`nextTaskNumber.ts` and `git rev-parse HEAD`) and now takes both `$1` and
`$2`, because computing the file groups requires `numSplits`. `close` cannot
run that way — it additionally needs child task numbers that don't exist
until `create-task` has been invoked mid-conversation — so it is written as
an instruction for the agent to run via its Bash tool. There is no groups
file and no `validate` subcommand: the partition is fully determined by
`info`'s two arguments, so there is nothing left for the agent to author or
for a separate validation step to check before children are created — a bad
split (too few files for `numSplits`) already fails at the `info` step,
before any child is created.

## File 4 (edit): `skills/create-task/SKILL.md`

Read in full. Find this exact two-paragraph block (the "invoke
AskUserQuestion to ask for an example test" paragraph immediately followed
by the "Append ONE object to the `tasks.json` array" paragraph):

```
Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's `tests` field to the literal string `skip`. Otherwise set `tests` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:
```

Insert one new paragraph between those two — before the task is appended at
all, not after — so an oversized task is offered a split before it's
written rather than after. Replace that exact block with:

```
Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's `tests` field to the literal string `skip`. Otherwise set `tests` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around.

Skip this oversized-task assessment entirely when this invocation of `/create-task` carries the marker `[split-task-child]` (see `skills/split-task/SKILL.md`) — that marker means `/split-task` is creating one of an already-requested set of children, and offering another split here would stop `/split-task` from collecting exactly `numSplits` child task numbers. Otherwise, assess whether this task is oversized: would its difficulty (on the template's 1–5 scale) be 4 or 5, or does its description read as a list of many enumerated steps rather than one piece of work? If so, invoke AskUserQuestion offering two choices: create this task as a single task, or create it and immediately split it into smaller tasks. If the user chooses to split, invoke AskUserQuestion once more to get an integer number of children, at least 2. Continue with the steps below to create this task as normal (it becomes the parent) — once it has been appended and its task number is known, invoke `/split-task <thisTaskNumber> <numSplits>` immediately, and let its own closing confirmation replace the "Finally, confirm" step below.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:
```

This is the only edit to this file. No other line changes.

## `tests/splitTask.test.ts` — already covered as File 2 above; not a
second, separate edit.

## Verification

Run from the repo root after all four changes are made:

1. `node --test "tests/**/*.test.ts"`
   Expected: every `test(...)` block in `tests/splitTask.test.ts` passes, 0
   fail, and the existing `tests/closeTasks.test.ts` /
   `tests/getTaskDetails.test.ts` files still pass unaffected.

2. `test -f skills/split-task/SKILL.md && echo skill-exists`
   Expected output: `skill-exists`.

3. `rg -n "split-task" skills/create-task/SKILL.md`
   Expected: at least one match, the new heuristic paragraph inserted
   between the "example test" paragraph and the "Append ONE object" line.

4. `rg -n "^name: split-task$" skills/split-task/SKILL.md` and
   `rg -n 'argument-hint: "<taskNum> <numSplits>"' skills/split-task/SKILL.md`
   Expected: one match each, confirming the front matter landed exactly as
   specified.

5. `rg -n "partitionFiles|validateFileGroups|verifyChildFiles" scripts/splitTask.ts`
   Expected: all three functions present and exported, confirming the
   deterministic partition and the file-level validation (not just
   child-count validation) are actually wired into `closeParentTask`.

6. `git status --short` should show exactly these paths as new/modified:
   `scripts/splitTask.ts`, `tests/splitTask.test.ts`,
   `skills/split-task/SKILL.md`, `skills/create-task/SKILL.md` (plus
   whatever this plan file itself already shows). No other tracked file
   should appear.

7. Manually walk the `/split-task` loop in File 3 for a parent whose
   difficulty is 4 or 5, and check each child invocation: because it carries
   the `[split-task-child]` marker, `skills/create-task/SKILL.md`'s
   oversized-task assessment must NOT fire for that child — even when the
   child itself would otherwise read as difficulty 4 or 5 — so it does not
   offer another split or replace its normal task-number confirmation
   output. Confirm the loop ends with exactly `numSplits` child task numbers
   collected, no more and no fewer.
