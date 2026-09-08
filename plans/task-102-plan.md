# Task 102 Plan: no-argument `/split-task` candidates mode

## Why (context, do not re-derive)

`skills/split-task/SKILL.md:7` runs `node scripts/splitTask.ts info $ARGUMENTS[0] $ARGUMENTS[1]`
unconditionally. With no arguments, `$ARGUMENTS[0]`/`$ARGUMENTS[1]` substitute to empty text,
shell word-splitting drops them, and `runInfo` receives `rest[0] === undefined`, so
`toPositiveInt` throws. `main()` (scripts/splitTask.ts:179-193) only recognizes `info` and
`close`. We add a third CLI mode, `candidates`, and branch in SKILL.md so a no-arg invocation
runs it, reports the list, and stops.

Qualifying rule (decided with the user, do not re-derive): an open task qualifies when
`difficulty >= 3` OR its `files` array has more than 3 entries. A qualifying task with fewer
than 2 files must still be listed, marked unsplittable, carrying its real file count (mirrors
`partitionFiles` at scripts/splitTask.ts:27-42, which requires at least 2 files to split into
2+ groups). Closed tasks are excluded by construction: `readTaskLists`'s `openTasks` (already
used this way at scripts/splitTask.ts:5-8) never contains a closed task — no separate check is
needed. Sort ascending by task number.

`TaskRecord` (imported at scripts/splitTask.ts:3 from `./taskFiles.ts`, not an owned file) has
an already-established access pattern in this file: `parent.files as string[] | undefined`
(line 150) — a direct `as` cast, meaning `.files` is type-compatible with that cast regardless
of its declared shape. `.taskNumber` is accessed with no cast at all (line 7), meaning it's
already typed `number`. Neither `.difficulty` nor `.title` is accessed anywhere in this file
today, so their declared types are unknown to this plan. To guarantee the new code compiles
regardless of `TaskRecord`'s real shape, every access to `.difficulty` and `.title` goes
through a `task as unknown as Record<string, unknown>` cast first (an `unknown` round-trip
always type-checks) and then casts the individual field, exactly as `.files` is already cast
at the use site. This resolves the unknown-type question without reading `taskFiles.ts`.

## Edits to scripts/splitTask.ts

### Edit 1 — add `SplitCandidate` type and `findSplitCandidates` function

Insert between `readParentTask` (ends line 25) and `partitionFiles` (starts line 27).

Current text (lines 24-27):
```
    return parent;
}

export function partitionFiles(files: string[], numSplits: number): string[][] {
```

Replace with:
```
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
        const fileCount = ((record.files as string[] | undefined) ?? []).length;
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
```

### Edit 2 — add `runCandidates`

Insert between `runClose` (ends line 177) and `main` (starts line 179).

Current text (lines 174-179):
```
function runClose(parentNumberArg: string, numSplitsArg: string, childNumbersArg: string, fileGroupsArg: string): void {
    const parentNumber = toPositiveInt(parentNumberArg, "parentNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const childNumbers = (childNumbersArg ?? "").split(",").map((raw) => toPositiveInt(raw.trim(), "childNumber"));
    const childFileGroups = parseFileGroups(fileGroupsArg ?? "");
    const result = closeParentTask(parentNumber, numSplits, childNumbers, childFileGroups);
    console.log(JSON.stringify(result, null, 2));
}

function main(): void {
```

Replace with:
```
function runClose(parentNumberArg: string, numSplitsArg: string, childNumbersArg: string, fileGroupsArg: string): void {
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
```

### Edit 3 — recognize `candidates` in `main()`

Current text (lines 179-193):
```
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
    console.error(
        "Usage: splitTask.ts info <taskNum> <numSplits> | splitTask.ts close <parentNum> <numSplits> <childNum1,childNum2,...> <fileGroupsJson>",
    );
    process.exitCode = 1;
}
```

Replace with:
```
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
```

No other edits to scripts/splitTask.ts. `readTaskLists` is already imported at line 1; no new
import needed.

## Edits to skills/split-task/SKILL.md

### Edit 1 — argument-hint (line 4)

Current text:
```
argument-hint: "<taskNum> <numSplits> [guidance]"
```

Replace with:
```
argument-hint: "[<taskNum> <numSplits> [guidance]]"
```

The outer brackets mark the whole `<taskNum> <numSplits> [guidance]` group as optional — the
no-arg form.

### Edit 2 — branch the command and the instructions (lines 7-13)

Current text:
```
- parent task and file groups: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $ARGUMENTS[0] $ARGUMENTS[1]`

Parent task number: $ARGUMENTS[0]. Number of children to create: $ARGUMENTS[1].

Guidance (optional): take the raw `$ARGUMENTS` for this invocation and strip its first two whitespace-delimited tokens (the task number and the split count) from the front. Whatever text remains, with its internal spacing preserved exactly, is the guidance string — do not use the third positional substitution, which captures only the first remaining word and would silently truncate a multi-word guidance. If nothing remains after stripping the first two tokens, there is no guidance for this invocation.

The command above printed the parent task's full record and the $ARGUMENTS[1] file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $ARGUMENTS[1] ways), stop here and report the error to the user instead of continuing.
```

Replace with:
```
- parent task and file groups, or split candidates when no arguments were given: !`if [ -z "$ARGUMENTS" ]; then node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" candidates; else node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $ARGUMENTS[0] $ARGUMENTS[1]; fi`

If no arguments were given ($ARGUMENTS is empty), the command above ran in `candidates` mode and printed a JSON array of open tasks that qualify for splitting (difficulty >= 3 or more than 3 files), sorted ascending by task number; a qualifying task with fewer than 2 files carries `unsplittable: true` and its real `fileCount`. Report that list to the user — each task's number, title, and whether it is splittable or marked unsplittable with its file count — and stop here: do not create any child tasks, do not run the `close` command, and skip the rest of this skill for this invocation. If the array is empty, tell the user no open tasks currently qualify for splitting.

Otherwise, arguments were given and the command above ran in `info` mode. Parent task number: $ARGUMENTS[0]. Number of children to create: $ARGUMENTS[1].

Guidance (optional): take the raw `$ARGUMENTS` for this invocation and strip its first two whitespace-delimited tokens (the task number and the split count) from the front. Whatever text remains, with its internal spacing preserved exactly, is the guidance string — do not use the third positional substitution, which captures only the first remaining word and would silently truncate a multi-word guidance. If nothing remains after stripping the first two tokens, there is no guidance for this invocation.

The command above printed the parent task's full record and the $ARGUMENTS[1] file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $ARGUMENTS[1] ways), stop here and report the error to the user instead of continuing.
```

No other edits to skills/split-task/SKILL.md. The rest of the file (the `/create-task` loop and
the `close` command instructions, lines 15 onward in the original) is unchanged — it only ever
runs in the args-given (`info`) branch, which is unaffected in substance by this edit.

## Edits to tests/splitTask.test.ts

### Edit 1 — import `findSplitCandidates`

Current text (lines 6-15):
```
import {
    closeParentTask,
    composeClosureNote,
    parseFileGroups,
    partitionFiles,
    readParentTask,
    validateChildNumbers,
    validateFileGroups,
    verifyChildFiles,
} from "../scripts/splitTask.ts";
```

Replace with:
```
import {
    closeParentTask,
    composeClosureNote,
    findSplitCandidates,
    parseFileGroups,
    partitionFiles,
    readParentTask,
    validateChildNumbers,
    validateFileGroups,
    verifyChildFiles,
} from "../scripts/splitTask.ts";
```

### Edit 2 — add coverage for `findSplitCandidates`

Insert between the `parseFileGroups` test (ends line 244) and the SKILL.md test (starts line
246).

Current text (lines 240-246):
```
test("parseFileGroups decodes valid JSON and rejects malformed or wrongly-shaped input", () => {
    assert.deepEqual(parseFileGroups('[["a.ts","b.ts"],["c.ts"]]'), [["a.ts", "b.ts"], ["c.ts"]]);
    assert.throws(() => parseFileGroups("not json"));
    assert.throws(() => parseFileGroups('[["a.ts"], "b.ts"]'));
});

test("SKILL.md advertises the guidance argument and extracts it via $ARGUMENTS, not the truncating $3", () => {
```

Replace with:
```
test("parseFileGroups decodes valid JSON and rejects malformed or wrongly-shaped input", () => {
    assert.deepEqual(parseFileGroups('[["a.ts","b.ts"],["c.ts"]]'), [["a.ts", "b.ts"], ["c.ts"]]);
    assert.throws(() => parseFileGroups("not json"));
    assert.throws(() => parseFileGroups('[["a.ts"], "b.ts"]'));
});

test("findSplitCandidates lists open tasks qualifying on difficulty or file count, sorted ascending, unsplittable flagged, closed tasks excluded", () => {
    const root = mkdtempSync(join(tmpdir(), "split-task-"));
    writeTaskFiles(
        root,
        [
            { taskNumber: 91, title: "Hard task", difficulty: 5, files: ["a.ts"] },
            { taskNumber: 12, title: "Wide task", difficulty: 1, files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] },
            { taskNumber: 5, title: "Small task", difficulty: 2, files: ["a.ts", "b.ts"] },
        ],
        [{ taskNumber: 999, title: "Closed but would qualify", difficulty: 9, files: ["a.ts", "b.ts", "c.ts", "d.ts"] }],
    );
    const candidates = findSplitCandidates(root);
    assert.deepEqual(
        candidates.map((c) => c.taskNumber),
        [12, 91],
    );
    const task91 = candidates.find((c) => c.taskNumber === 91)!;
    assert.equal(task91.unsplittable, true);
    assert.equal(task91.fileCount, 1);
    const task12 = candidates.find((c) => c.taskNumber === 12)!;
    assert.equal(task12.unsplittable, false);
    assert.equal(task12.fileCount, 5);
});

test("SKILL.md advertises the guidance argument and extracts it via $ARGUMENTS, not the truncating $3", () => {
```

This one test covers all four goal bullets that concern `findSplitCandidates`: qualifying by
difficulty (task 91), qualifying by file count (task 12), non-qualifying task excluded (task
5, never appears), ascending sort (`[12, 91]` not `[91, 12]`), unsplittable-with-real-count for
a qualifying task under 2 files (task 91: `unsplittable: true`, `fileCount: 1`), and closed
tasks excluded (task 999, never appears despite qualifying on both rules). `mkdtempSync`,
`tmpdir`, `join`, and `writeTaskFiles` are already available (imported at lines 3-5, defined at
lines 17-21) — no new imports beyond `findSplitCandidates` are needed.

### Edit 3 — update the argument-hint regex to match the new hint text

Current text (line 248):
```
    assert.match(skillMd, /argument-hint: "<taskNum> <numSplits> \[guidance\]"/);
```

Replace with:
```
    assert.match(skillMd, /argument-hint: "\[<taskNum> <numSplits> \[guidance\]\]"/);
```

This test reads the live SKILL.md file (`readFileSync` at line 247) and must match the new
argument-hint text from the SKILL.md Edit 1 above, or it fails.

No other edits to tests/splitTask.test.ts. The rest of the SKILL.md test (lines 249-251,
checking `\$ARGUMENTS` presence and `\$3` absence) is unaffected — the new SKILL.md body still
uses `$ARGUMENTS` and does not introduce `$3`.

## Verification

Run from the repo root:

```
npm test
```

Expected: all tests pass, including the three existing `splitTask.test.ts` tests that were
unmodified, the updated argument-hint regex test, and the new `findSplitCandidates` test. (Per
project memory: use `npm test`, not `bun test` — `bun test` reports one unrelated false
failure in `mergeTaskWorktrees`.)

To isolate this file only:

```
node --test tests/splitTask.test.ts
```

Expected: `# pass 21` (20 pre-existing tests + 1 new `findSplitCandidates` test), `# fail 0`.

Manual smoke test of the new CLI mode against the real task data:

```
node scripts/splitTask.ts candidates
```

Expected: exits 0, prints a JSON array to stdout (`[]` if no open task currently qualifies, or
one object per qualifying task with `taskNumber`, `title`, `difficulty`, `fileCount`, and
`unsplittable` fields, sorted ascending by `taskNumber`).
