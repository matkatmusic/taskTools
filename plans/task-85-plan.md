# Task 85 plan: guidance argument for `/split-task`

## Goal

Add an optional free-text `guidance` argument to `/split-task <taskNum>
<numSplits> [guidance]` that drives both the child descriptions and the file
split. Today the file grouping is fixed by `partitionFiles`'s contiguous
positional slice of the parent's `files` array; guidance must be able to
override that grouping (the user's own example — "make splitting task-file
ownership one task and making briefs point using filepaths the other task" —
does not correspond to a contiguous slice). Absent guidance, behaviour must
stay exactly as it is today.

Three owned files, three edits:
1. `skills/split-task/SKILL.md` — argument-hint, guidance-extraction
   instructions, and the child-creation / close-command paragraphs rewritten
   to stop treating the file grouping as fixed.
2. `scripts/splitTask.ts` — `closeParentTask` takes the per-child file
   groups as an explicit parameter instead of recomputing
   `partitionFiles`; `runClose`/`main` gain a 4th CLI argument
   (`fileGroupsJson`) and a small JSON-parsing helper to decode it.
3. `tests/splitTask.test.ts` — every existing `closeParentTask(...)` call
   site gets the new `childFileGroups` argument (required by the new
   signature, or the code won't compile); four new tests cover the new
   capability (non-contiguous grouping succeeds; a file-groups/numSplits
   count mismatch throws; `parseFileGroups` decodes/rejects input directly;
   `SKILL.md` documents the guidance argument via `$ARGUMENTS`, not `$3`).

Confirmed via `rg` across the repo (excluding the three owned files) that no
other source file calls `closeParentTask`, `runClose`, `verifyChildFiles`,
`partitionFiles`, or `validateFileGroups` — only `plans/*.md` docs mention
these names in prose/quoted code, which are not executed. The signature
change is safe to make without touching any file outside the owned list.

---

## Edit 1: `skills/split-task/SKILL.md`

### 1a. Frontmatter `argument-hint` (line 4)

Current text:
```
argument-hint: "<taskNum> <numSplits>"
```
Becomes:
```
argument-hint: "<taskNum> <numSplits> [guidance]"
```

### 1b. Guidance extraction + "grouping is fixed" paragraph (lines 9–13)

Current text (lines 9 through 13, verbatim, including the blank lines
between them):
```
Parent task number: $1. Number of children to create: $2.

The command above printed the parent task's full record and the $2 file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $2 ways), stop here and report the error to the user instead of continuing.

Read the parent's `title`, `description`, and `userDescription`. Decide $2 reasonable split points in the parent's work — logically separable pieces of what the parent asks for — and match each split point, in order, to the file groups printed above: file group 1 becomes child 1's `files`, file group 2 becomes child 2's `files`, and so on. The file grouping itself is fixed by the command's output; the only decision here is which piece of work (child description) goes with each group.
```

Becomes:
```
Parent task number: $1. Number of children to create: $2.

Guidance (optional): take the raw `$ARGUMENTS` for this invocation and strip its first two whitespace-delimited tokens (the task number and the split count) from the front. Whatever text remains, with its internal spacing preserved exactly, is the guidance string — do not use the third positional substitution, which captures only the first remaining word and would silently truncate a multi-word guidance. If nothing remains after stripping the first two tokens, there is no guidance for this invocation.

The command above printed the parent task's full record and the $2 file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $2 ways), stop here and report the error to the user instead of continuing.

Read the parent's `title`, `description`, and `userDescription`. If guidance was given, use it to decide both $2 reasonable split points in the parent's work and which of the parent's files belong to each split point: the file groups printed above are only a suggested starting point, not the final grouping, and you may reassign files across children to match the guidance as long as every parent file ends up in exactly one child's group and no child claims a file the parent doesn't have. If no guidance was given, decide $2 reasonable split points in the parent's work and match each split point, in order, to the file groups printed above: file group 1 becomes child 1's `files`, file group 2 becomes child 2's `files`, and so on, unchanged from the command's output. Either way, write down each child's final file list now — it is what you will pass to `/create-task` below and to the `close` command afterward.
```

### 1c. `/create-task` invocation paragraph (line 15)

Current text (verbatim):
```
For each of the $2 children, in order, invoke `/create-task` once with that child's description, and explicitly tell `/create-task` in that invocation, verbatim: "[split-task-child] This task is being created by `/split-task` as one of an already-requested set of $2 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `<that child's file group from the command output>`." The literal marker `[split-task-child]` at the start of that sentence is what `skills/create-task/SKILL.md` checks for to bypass its own oversized-task heuristic — every child invocation must carry it, even when a child's own difficulty would otherwise read as 4 or 5 and could trigger another split offer that would break this loop's numbering. Record the task number `create-task` reports back for each child, in the same order as the file groups printed above.
```

Becomes (only the file-list placeholder and the closing "record the task
number" clause change; the `[split-task-child]` marker sentence is otherwise
untouched, per the brief's instruction to keep that contract exactly as-is):
```
For each of the $2 children, in order, invoke `/create-task` once with that child's description, and explicitly tell `/create-task` in that invocation, verbatim: "[split-task-child] This task is being created by `/split-task` as one of an already-requested set of $2 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `<that child's final file list, decided above>`." The literal marker `[split-task-child]` at the start of that sentence is what `skills/create-task/SKILL.md` checks for to bypass its own oversized-task heuristic — every child invocation must carry it, even when a child's own difficulty would otherwise read as 4 or 5 and could trigger another split offer that would break this loop's numbering. Record the task number `create-task` reports back for each child, in the same order as the file lists you decided above.
```

### 1d. Line 17 (partial-failure rule) — no edit

Current text stays byte-for-byte as-is per the brief's instruction to keep
this rule intact:
```
If any `/create-task` invocation fails partway through this loop, stop immediately — do not run the close command, do not retry, and do not invoke `/create-task` for the remaining split points. Report to the user which children were already created (task numbers and titles) and that the parent task ($1) is still open and was not closed, so the user can decide how to clean up the partial children.
```

### 1e. "Once all $2 children exist" paragraph (line 19)

Current text:
```
Once all $2 children exist, run this command, replacing `<childNumbers>` with the collected child task numbers joined by commas, IN THE SAME ORDER as the file groups printed above:
```
Becomes:
```
Once all $2 children exist, run this command, replacing `<childNumbers>` with the collected child task numbers joined by commas (IN THE SAME ORDER as the file lists you decided above), and replacing `<shellQuotedFileGroupsJson>` as follows: first build the JSON text — a JSON array of arrays, one array of file paths per child in that same order, containing exactly the final file list you assigned to that child. Then, because that JSON text is about to sit on a shell command line where a `'` character inside a file path would otherwise break the command, make it shell-safe: replace every `'` character in the JSON text with the four characters `'"'"'`, then wrap the whole result in one leading and one trailing `'` character. That wrapped, escaped result — not the raw JSON — is what you substitute for `<shellQuotedFileGroupsJson>`; do not add another pair of quotes around it.
```

### 1f. Close command code block (lines 21–23)

Current text:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" close $1 $2 <childNumbers>
```
Becomes:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" close $1 $2 <childNumbers> <shellQuotedFileGroupsJson>
```
(Same fenced code block, only this one line inside it changes. Note there
are no literal quote characters around the placeholder in the code block —
`<shellQuotedFileGroupsJson>` already includes its own quoting per 1e.)

### 1g. Close-command explanation paragraph (line 25)

Current text:
```
This re-validates the child numbers, recomputes the same deterministic file groups from the parent's current `files` array, then loads each created child and checks that its actual `files` field exactly matches the group assigned to it — only if every child matches does it close the parent, moving it into `completedTasks.json` with `closureNote` set to `Split into <childNumbers>`. If this command fails — including because a child's real `files` field doesn't match its assigned group — report the error to the user and name which child mismatched; the parent was NOT closed and remains open, rather than telling the user the split succeeded.
```
Becomes:
```
This re-validates the child numbers, checks that the file groups decoded from `<shellQuotedFileGroupsJson>` exactly partition the parent's current `files` array (no file assigned to more than one child, no file outside the parent's list, no parent file missing from every group), then loads each created child and checks that its actual `files` field exactly matches the group assigned to it — only if every child matches does it close the parent, moving it into `completedTasks.json` with `closureNote` set to `Split into <childNumbers>`. If this command fails — including because the decoded file groups don't partition the parent's files, or because a child's real `files` field doesn't match its assigned group — report the error to the user and name which child or file mismatched; the parent was NOT closed and remains open, rather than telling the user the split succeeded.
```

### 1h. Line 27 (final confirmation) — no edit

Stays byte-for-byte as-is:
```
Finally, confirm to the user: the parent task number that was closed, and the numbers and titles of the children that replaced it.
```

### 1i. Lines 7 and 11 — no edit

Line 7 (the `info` command invocation, `!`node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $1 $2``) is unchanged: `runInfo` keeps its current two-argument signature (see Edit 2 — no source change to `runInfo`), so this line needs no edit. Line 11 (the "command above printed... too few files to split $2 ways" sentence) is reproduced unchanged inside the 1b replacement block above; it is not independently edited.

---

## Edit 2: `scripts/splitTask.ts`

### 2a. `closeParentTask` (lines 115–132) — accept `childFileGroups`, stop calling `partitionFiles`

Current text:
```
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
```

Becomes:
```
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
    validateFileGroups(parent.files as string[] | undefined, childFileGroups);
    childNumbers.forEach((childNumber, index) => verifyChildFiles(childNumber, childFileGroups[index], projectRoot));

    const result = closeTasks([parentNumber], composeClosureNote(childNumbers), projectRoot);
    if (!result.closed.includes(parentNumber)) {
        throw new Error(`Failed to close parent task ${parentNumber}`);
    }
    return result;
}
```

This is the crux of "guidance drives the file split too": `validateFileGroups`
(unchanged, lines 44–67) becomes the real gate on whatever grouping the
caller supplies, and `partitionFiles` is no longer called from
`closeParentTask` at all — it remains defined and exported (used only by
`runInfo`, see 2b) as the no-guidance suggested default. Failure semantics
are preserved: any failure (bad child numbers, wrong group count, a group
that doesn't partition the parent's files, or a child whose actual `files`
doesn't match its assigned group) throws before `closeTasks` runs, so the
parent is never closed and the thrown error names the offending child/file
(unchanged behaviour of `validateChildNumbers`, `validateFileGroups`, and
`verifyChildFiles`, none of which are edited).

### 2b. `runInfo` (lines 142–148) — no edit

Current text stays exactly as-is:
```
function runInfo(taskNumberArg: string, numSplitsArg: string): void {
    const taskNumber = toPositiveInt(taskNumberArg, "taskNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const parent = readParentTask(taskNumber);
    const fileGroups = partitionFiles((parent.files as string[] | undefined) ?? [], numSplits);
    console.log(JSON.stringify({ parent, fileGroups }, null, 2));
}
```
It still prints the parent record plus the positional partition as the
suggested default; it is simply no longer the authority on the final
grouping (that authority moves to `validateFileGroups` inside
`closeParentTask`, per 2a).

### 2c. `runClose` (lines 150–156) — new `parseFileGroups` helper, 4th argument

Current text:
```
function runClose(parentNumberArg: string, numSplitsArg: string, childNumbersArg: string): void {
    const parentNumber = toPositiveInt(parentNumberArg, "parentNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const childNumbers = (childNumbersArg ?? "").split(",").map((raw) => toPositiveInt(raw.trim(), "childNumber"));
    const result = closeParentTask(parentNumber, numSplits, childNumbers);
    console.log(JSON.stringify(result, null, 2));
}
```

Becomes (a new `parseFileGroups` function is inserted immediately before
`runClose`, and `runClose` gains the `fileGroupsArg` parameter). `parseFileGroups`
is exported (unlike `runInfo`/`runClose`/`main`) so `tests/splitTask.test.ts`
can test its JSON-parsing and shape-validation directly, per Edit 3:
```
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

function runClose(parentNumberArg: string, numSplitsArg: string, childNumbersArg: string, fileGroupsArg: string): void {
    const parentNumber = toPositiveInt(parentNumberArg, "parentNum");
    const numSplits = toPositiveInt(numSplitsArg, "numSplits");
    const childNumbers = (childNumbersArg ?? "").split(",").map((raw) => toPositiveInt(raw.trim(), "childNumber"));
    const childFileGroups = parseFileGroups(fileGroupsArg ?? "");
    const result = closeParentTask(parentNumber, numSplits, childNumbers, childFileGroups);
    console.log(JSON.stringify(result, null, 2));
}
```

### 2d. `main` (lines 219–233) — pass the 4th CLI argument, update usage string

Current text:
```
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
```

Becomes:
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

### 2e. Line-count check

Original file: 177 lines. Edit 2a adds 3 net lines (18 → 21). Edit 2c adds
the 15-line `parseFileGroups` function plus a blank separator line (+16) and
1 net line inside `runClose` itself (signature/body grows by one line for
the new `const childFileGroups = ...` statement, offset by the parameter
list staying on one line). Edit 2d is a same-line-count change (one call
site argument added, one string literal made longer). Net result: roughly
177 + 3 + 16 + 1 ≈ 197 lines — comfortably under the 250-line source cap.

### 2f. Nothing else in `scripts/splitTask.ts` changes

`isOpenTask`, `assertValidSplitCount`, `readParentTask`, `partitionFiles`
(function body itself, 27–42), `validateFileGroups` (44–67),
`composeClosureNote` (69–71), `validateChildNumbers` (73–99),
`verifyChildFiles` (101–113), and `toPositiveInt` (195–201) are all
unedited — confirmed by re-reading each and finding no requirement in the
brief that touches them.

---

## Edit 3: `tests/splitTask.test.ts`

The `closeParentTask` signature change (Edit 2a) means every existing call
site must gain the new `childFileGroups` argument or the file fails to
compile. The import list (lines 6–14) gains `parseFileGroups`, now exported
per Edit 2c, so its JSON-parsing and shape-validation can be tested directly.

Current import block:
```
import {
    closeParentTask,
    composeClosureNote,
    partitionFiles,
    readParentTask,
    validateChildNumbers,
    validateFileGroups,
    verifyChildFiles,
} from "../scripts/splitTask.ts";
```
Becomes:
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

### 3a. `"closeParentTask closes the parent and moves it to completedTasks.json"` test

Current text:
```
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
```
Becomes:
```
test("closeParentTask closes the parent and moves it to completedTasks.json", () => {
    const root = makeProjectRoot();
    const result = closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts"], ["c.ts", "d.ts"]], root);
    assert.deepEqual(result.closed, [58]);

    const completed = readCompleted(root);
    const closedParent = completed.find((task: { taskNumber: number }) => task.taskNumber === 58);
    assert.equal(closedParent.closureNote, "Split into 66, 67");

    const open = readTasks(root).map((task: { taskNumber: number }) => task.taskNumber).sort();
    assert.deepEqual(open, [66, 67]);
});
```

### 3b. `"closeParentTask throws and leaves the parent open when child numbers are invalid"` test

Current text:
```
test("closeParentTask throws and leaves the parent open when child numbers are invalid", () => {
    const root = makeProjectRoot();
    assert.throws(() => closeParentTask(58, 2, [66, 999], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});
```
Becomes:
```
test("closeParentTask throws and leaves the parent open when child numbers are invalid", () => {
    const root = makeProjectRoot();
    assert.throws(() => closeParentTask(58, 2, [66, 999], [["a.ts", "b.ts"], ["c.ts", "d.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});
```

### 3c. `"closeParentTask throws and leaves the parent open when a child omits a file from its assigned group"` test

Current text:
```
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
```
Becomes (the `[["a.ts", "b.ts"], ["c.ts"]]` groups fully partition the
parent's 3 files; child 66's actual stored `files` — `["a.ts"]` — omits
`b.ts` from its assigned group, so `verifyChildFiles` still throws):
```
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
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts"], ["c.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});
```

### 3d. `"closeParentTask throws and leaves the parent open when a child claims a file outside its assigned group"` test

Current text:
```
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
```
Becomes (`[["a.ts"], ["b.ts"]]` fully and validly partitions the parent's 2
files; child 66's actual stored `files` — `["a.ts", "z.ts"]` — claims
`z.ts`, which is outside its assigned group, so `verifyChildFiles` throws):
```
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
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts"], ["b.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});
```

### 3e. `"closeParentTask throws and leaves the parent open when a child's files drifted from its assigned group"` test

Current text:
```
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
Becomes:
```
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
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts"], ["c.ts", "d.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});
```

### 3f. Two new tests appended at end of file (after the 3e test, before end of file)

Insert immediately after the closing `});` of the (now-updated) last test in
the file — the "drifted from its assigned group" test from 3e — and before
the file's final newline:

```

test("closeParentTask succeeds with a non-contiguous file grouping that fully partitions the parent's files", () => {
    const root = makeProjectRoot();
    writeTaskFiles(
        root,
        [
            { taskNumber: 58, title: "Big task", files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
            { taskNumber: 66, title: "Child A", files: ["a.ts", "c.ts"] },
            { taskNumber: 67, title: "Child B", files: ["b.ts", "d.ts"] },
        ],
        [],
    );
    const result = closeParentTask(58, 2, [66, 67], [["a.ts", "c.ts"], ["b.ts", "d.ts"]], root);
    assert.deepEqual(result.closed, [58]);
});

test("closeParentTask throws when the number of file groups doesn't match numSplits", () => {
    const root = makeProjectRoot();
    assert.throws(() => closeParentTask(58, 2, [66, 67], [["a.ts", "b.ts", "c.ts", "d.ts"]], root));
    assert.ok(readTasks(root).some((task) => task.taskNumber === 58));
});
```

This proves the core new capability end to end: a grouping that
`partitionFiles` could never produce (files interleaved instead of sliced
contiguously) is accepted by `closeParentTask` as long as it's a valid
partition of the parent's files and matches each child's actual stored
`files` — exactly what guidance-driven splitting needs. The second new test
guards the `childFileGroups.length !== numSplits` check added in Edit 2a.

### 3g. `parseFileGroups` test — appended immediately after the 3f tests

`parseFileGroups` decodes the CLI's raw `fileGroupsArg` string (what the
SKILL.md `close` command line passes as `<shellQuotedFileGroupsJson>`, after
the shell has already stripped the quoting) into `string[][]`. This test
exercises it directly, independent of `closeParentTask`, covering the three
cases the function distinguishes: valid JSON, syntactically malformed JSON,
and syntactically valid JSON with the wrong shape.

```

test("parseFileGroups decodes valid JSON and rejects malformed or wrongly-shaped input", () => {
    assert.deepEqual(parseFileGroups('[["a.ts","b.ts"],["c.ts"]]'), [["a.ts", "b.ts"], ["c.ts"]]);
    assert.throws(() => parseFileGroups("not json"));
    assert.throws(() => parseFileGroups('[["a.ts"], "b.ts"]'));
});
```

### 3h. SKILL.md content test — appended immediately after the 3g test

This test reads the actual `skills/split-task/SKILL.md` file and asserts on
its text, so a regression that reintroduces the truncating `$3` positional,
or drops the `$ARGUMENTS`-based guidance extraction, or reverts the
`argument-hint`, fails the suite instead of only being caught by manual
review.

```

test("SKILL.md advertises the guidance argument and extracts it via $ARGUMENTS, not the truncating $3", () => {
    const skillMd = readFileSync(join(import.meta.dirname, "..", "skills", "split-task", "SKILL.md"), "utf8");
    assert.match(skillMd, /argument-hint: "<taskNum> <numSplits> \[guidance\]"/);
    assert.match(skillMd, /\$ARGUMENTS/);
    assert.doesNotMatch(skillMd, /\$3/);
});
```

### 3i. Nothing else in `tests/splitTask.test.ts` changes

`writeTaskFiles`, `makeProjectRoot`, `readTasks`, `readCompleted`, and every
test not calling `closeParentTask`, `parseFileGroups`, or reading SKILL.md
(the `readParentTask`, `partitionFiles`, `validateFileGroups`,
`composeClosureNote`, `validateChildNumbers`, and `verifyChildFiles` tests)
are unedited — none of those functions' exported signatures change.

---

## Verification

Run from the repo root after all three files are edited:

1. `node --test tests/splitTask.test.ts`
   Expected: every test passes, 0 failures — 26 tests total (22 existing,
   2 new from 3f, 1 new from 3g, 1 new from 3h), including the updated
   `closeParentTask` call sites from 3a–3e and the four new tests.

2. `node --test "tests/**/*.test.ts"`
   Expected: the full suite passes, confirming no other test file was
   broken by the signature change (none should be, per the repo-wide `rg`
   check above showing no other consumer of `closeParentTask`).

3. `tsc --noEmit`
   Expected: no type errors — confirms `closeParentTask`'s new
   `childFileGroups: string[][]` parameter, `parseFileGroups`'s `unknown` →
   `string[][]` narrowing, and every updated call site in
   `tests/splitTask.test.ts` type-check under the repo's `strict: true`
   `tsconfig.json`.

4. `rg -n 'argument-hint: "<taskNum> <numSplits> \[guidance\]"' skills/split-task/SKILL.md`
   Expected: exactly one match, confirming edit 1a landed.

5. `rg -n 'ARGUMENTS' skills/split-task/SKILL.md`
   Expected: exactly one match (the new guidance-extraction paragraph from
   edit 1b), confirming the `$ARGUMENTS`-stripping instruction landed and
   the file does not instead reference `$3`.

6. `rg -n '\$3' skills/split-task/SKILL.md`
   Expected: no matches — confirms the file never uses the truncating `$3`
   positional for guidance.

7. `rg -n '\[split-task-child\]' skills/split-task/SKILL.md`
   Expected: exactly one match, unchanged from before this task, confirming
   the marker contract with `skills/create-task/SKILL.md` is intact.

8. `rg -n 'childFileGroups: string\[\]\[\]' scripts/splitTask.ts`
   Expected: exactly one match, in `closeParentTask`'s parameter list,
   confirming edit 2a landed.

9. `rg -n 'runClose\(rest\[0\], rest\[1\], rest\[2\], rest\[3\]\)' scripts/splitTask.ts`
   Expected: exactly one match, confirming edit 2d landed.

10. `wc -l scripts/splitTask.ts`
    Expected: a number under 250 (roughly 195–200 per the estimate in 2e),
    confirming the file stays under the source cap.
