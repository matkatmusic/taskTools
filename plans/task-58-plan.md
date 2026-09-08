# Task 58 plan: split task file ownership into modifiableFiles and readOnlyFiles

All line numbers below were read directly from the live files on disk during this planning
pass (confirmed byte-identical to the snapshots embedded in `plans/brief-58.md`). Every edit
is exact; the implementer should not need to re-derive anything.

## Design decisions (the "why" behind non-obvious choices)

1. **Shared accessor pair lives in `scripts/taskGroups.ts`, not a new file.** The brief asks
   for "one shared accessor pair" used by both `scripts/prepareTasks.ts` and
   `scripts/taskGroups.ts`. `prepareTasks.ts` already imports from `taskGroups.ts`, and
   `taskGroups.ts` never imports `prepareTasks.ts`, so defining the pair in `taskGroups.ts`
   and having `prepareTasks.ts` import it avoids a circular import and avoids creating a new
   file outside this task's owned-file list.

2. **`declaredFiles` stays exported from `taskGroups.ts` as a legacy alias.** A repo-wide
   check (`rg -n "declaredFiles"`) found three files outside the owned list that import
   `declaredFiles` from `taskGroups.ts` by that exact name: `scripts/canonicalTaskGroups.ts`,
   `scripts/taskStats.ts`, and `scripts/mergeTaskWorktrees.ts`. None of these are editable by
   this task. Renaming or removing the export would break their imports and fail typecheck.
   Instead, `taskGroups.ts` gains two new exports, `modifiableFiles` and `readOnlyFiles`, and
   keeps exporting `declaredFiles` as `export const declaredFiles = modifiableFiles;` — the
   same function under its old name. Because `buildCanonicalTaskGroups` (the production
   grouping path, in the unowned `canonicalTaskGroups.ts`) calls `declaredFiles(task)`
   internally, and that name now resolves to the modifiableFiles-aware implementation, the
   production grouping path automatically gains support for the new `modifiableFiles` key and
   the legacy `files` fallback — with zero edits to `canonicalTaskGroups.ts`.

3. **`scripts/approvalGate.ts` gains an optional `readOnlyFiles` field, `files` is not
   renamed.** A targeted check (`rg -n "files" tests/approvalGate.test.ts`) found that the
   unowned test file `tests/approvalGate.test.ts` directly constructs `ApprovalDigestInput`
   objects with a `files:` key and mutates `.files` at three call sites (lines 16, 61, 138),
   none of which set a `readOnlyFiles` key. Renaming `ApprovalDigestInput.files` would break
   that unowned test file's compilation, which this task cannot fix. Instead
   `ApprovalDigestInput` gains `readOnlyFiles?: string[];` — optional, so those three unowned
   call sites (which omit it) still satisfy the type and still compile; an absent optional
   property is simply absent from `stableStringify`'s `Object.keys` walk, so none of that
   file's digest-equality assertions changes either. `scripts/mergePipeline.ts` (edited below)
   populates this new field from each prepared task's `readOnlyFiles`, so the approval digest
   now captures read-scope drift the way it already captures edit-scope drift.

4. **`TaskGroup` (in `taskGroups.ts`) is not given a `readOnlyFiles` field.** `TaskGroup` is
   also produced by `buildCanonicalTaskGroups` in the unowned `canonicalTaskGroups.ts`; adding
   a required field there would need an edit to that file. Instead,
   `buildWorkflowArguments` (in `prepareTasks.ts`, owned) gains a new parameter,
   `tasks: TaskRecord[]`, carrying the original task records already available at its only
   call site. Inside, it looks up each task by number and reads that task's own
   `readOnlyFiles` directly via the shared accessor — never a group-level aggregate — without
   touching `TaskGroup`'s shape at all.

5. **`readOnlyFiles` stays per task; it is never aggregated across a group.**
   `modifiableFiles` (`filePaths`) is aggregated to the whole group because the group is the
   real worktree-ownership boundary: every task in a group shares one worktree, so every
   task's worker must be able to edit every file any task in that group owns. Reads are not a
   shared-worktree concern, and a task's declared read fence must not widen just because a
   sibling task in the same group declared a broader one (or `["*"]`). So each
   `PreparedTask.readOnlyFiles` is exactly that task's own `readOnlyFiles(sourceTask)` result,
   looked up by task number from the new `tasks` parameter; a task number with no matching
   record (the 3-argument, backward-compatible call shape) defaults to `["*"]`, matching
   "missing means every file is readable" without touching any other task's value.

6. **`buildWorkflowArguments`'s new `tasks` parameter has a default of `[]`.** The only real
   caller (`runAsCli`) will pass the real array. The two existing test files that call
   `buildWorkflowArguments` with 3 arguments do not need to change, because an empty default
   safely resolves to `readOnlyFiles: ["*"]` for every task (matching "missing means every
   file is readable").

7. **The four workflow prompts get a `readScope(t)` helper, duplicated per file.** This
   matches the existing `retryAgent` helper, which is already duplicated across all four
   files with a `// ponytail: ... Duplicated per file.` comment — same pattern, same reason
   (these are independent prompt-generator files with no shared import path).
   `skills/tackle-tasks/test.workflow.js` additionally gets a `readScopeForTasks(tasks)`
   helper (also duplicated, same reason), because its `testerBrief` runs once per group
   covering every task in that group, not one task at a time like the other three files: it
   unions every participating task's `modifiableFiles` and `readOnlyFiles`, collapsing to
   "every file in the project" if any task in that group has `["*"]`.

8. **Implementer and fixer prohibitions say "edit or git-add", never "touch."** The bare word
   "touch" reads as forbidding reads too, which would contradict the same brief's instruction,
   two lines earlier, to read `readableFiles` for context. Every forbidden-actions sentence in
   `implement.workflow.js` and `test.workflow.js`'s `fixerBrief` is edited to say "edit or
   git-add" so the prohibition targets writes only.

9. **The planner's forbidden-reads clause explicitly exempts the brief file and the planning
   guide.** `plannerBrief` already instructs the planner to read `${t.briefFile}` (line 27)
   and to follow `~/.claude/guides/planning.md` (line 30) — neither is a project source file
   inside `readScope(t)`. A bare "forbidden to read anything outside `${readScope(t)}`" would
   contradict those two required reads, so the forbidden clause names both exemptions
   explicitly.

## File-by-file edits

### scripts/taskGroups.ts (62 lines → ~76 lines)

Replace lines 15-17:
```
export function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}
```
with:
```
export function modifiableFiles(task: TaskRecord): string[] {
    const extended = task as TaskRecord & { modifiableFiles?: unknown };
    if (Array.isArray(extended.modifiableFiles)) return extended.modifiableFiles as string[];
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

export function readOnlyFiles(task: TaskRecord): string[] {
    const extended = task as TaskRecord & { readOnlyFiles?: unknown };
    if (!Array.isArray(extended.readOnlyFiles)) return ["*"];
    const declared = extended.readOnlyFiles as string[];
    return declared.includes("*") ? ["*"] : declared;
}

// Legacy alias: scripts/canonicalTaskGroups.ts, scripts/taskStats.ts, and scripts/mergeTaskWorktrees.ts import this name and sit outside this task's owned files.
export const declaredFiles = modifiableFiles;
```
(The `TaskRecord & { modifiableFiles?: unknown }` cast is needed because `TaskRecord`, in the
unowned `scripts/taskFiles.ts`, does not declare these two new fields, and this task cannot
edit that file. The cast lets the accessor read the new fields without widening
`TaskRecord`'s own declared type.)

Then rename the three internal call sites (still inside `groupTasksByExactFileOverlapWithNoManifest`)
from `declaredFiles(...)` to `modifiableFiles(...)`:
- Line 32: `for (const file of declaredFiles(task)) {` → `for (const file of modifiableFiles(task)) {`
- Line 38: `const unknownTasks = tasks.filter((task) => declaredFiles(task).length === 0);` → `const unknownTasks = tasks.filter((task) => modifiableFiles(task).length === 0);`
- Line 51: `const filePaths = [...new Set(members.flatMap((m) => declaredFiles(m)))].sort();` → `const filePaths = [...new Set(members.flatMap((m) => modifiableFiles(m)))].sort();`

No other lines in this file change. `groupTasksByFileOverlap` (lines 59-62) is untouched —
grouping still keys off modifiable files only, exactly as before, satisfying "readOnlyFiles
must never widen a group."

### scripts/prepareTasks.ts (231 lines → ~246 lines)

Line 3, remove the now-unused `readFileSync` import (its only use was in the old
`writeTaskBriefFile`, which no longer reads file contents):
```
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
```
→
```
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
```

Line 9, import the two new accessors:
```
import { groupTasksByFileOverlap } from "./taskGroups.ts";
```
→
```
import { groupTasksByFileOverlap, modifiableFiles, readOnlyFiles } from "./taskGroups.ts";
```

Lines 13-18, rename `PreparedTask.files` and add `readOnlyFiles`:
```
export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    files: string[];
};
```
→
```
export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    modifiableFiles: string[];
    readOnlyFiles: string[];
};
```

Line 54, inside `selectRequestedTasks`, switch to the shared accessor:
```
    const undeclaredNumbers = runnableTasks.filter((task) => declaredFiles(task).length === 0).map((task) => task.taskNumber);
```
→
```
    const undeclaredNumbers = runnableTasks.filter((task) => modifiableFiles(task).length === 0).map((task) => task.taskNumber);
```

Lines 58-62, update the refusal message's wording (it still matches the existing test regexes
`/files/i`, `/\b2\b/`, and `/update-task-files/`, since "modifiableFiles" contains "Files"):
```
            `these tasks declare no "files" and cannot be planned or implemented: ${numbers}. `
            + `A task's "files" array is both the worker's ownership fence and the key that decides `
            + `what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
```
→
```
            `these tasks declare no "modifiableFiles" (or legacy "files") and cannot be planned or implemented: ${numbers}. `
            + `A task's "modifiableFiles" array (or "files" for legacy tasks) is both the worker's ownership fence and the key that decides `
            + `what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
```

Lines 99-102 (the local `declaredFiles` helper plus its trailing blank line), delete entirely:
```
function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

```
(The blank line at 98, already present before this block, becomes the single separator before
`writeTaskBriefFile`.)

Lines 103-121 (now shifted up by 4 after the deletion above — refer to it by its current
content, not a post-deletion line number), replace the whole `writeTaskBriefFile` function:
```
export function writeTaskBriefFile(task: TaskRecord, repoRoot: string): string {
    const briefFile = join(repoRoot, "plans", `brief-${task.taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    const fileSections = declaredFiles(task).map((file) => {
        const fullPath = join(repoRoot, file);
        if (!existsSync(fullPath)) return `### ${file}\n\n(missing: file not found on disk)\n`;
        return `### ${file}\n\n\`\`\`\n${readFileSync(fullPath, "utf8")}\n\`\`\`\n`;
    });
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        ...(task.userDescription ? [`## User request\n\n${task.userDescription}`, ""] : []),
        task.description ?? "",
        "",
        ...fileSections,
    ].join("\n");
    writeFileSync(briefFile, content);
    return briefFile;
}
```
with:
```
export function writeTaskBriefFile(task: TaskRecord, repoRoot: string): string {
    const briefFile = join(repoRoot, "plans", `brief-${task.taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    const pathLine = (file: string): string =>
        existsSync(join(repoRoot, file)) ? `- ${file}` : `- ${file} (missing: file not found on disk)`;
    const readable = readOnlyFiles(task);
    const readableSection = readable.includes("*")
        ? "Every file in the project ([*])."
        : readable.map(pathLine).join("\n");
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        ...(task.userDescription ? [`## User request\n\n${task.userDescription}`, ""] : []),
        task.description ?? "",
        "",
        "## Modifiable files",
        "",
        modifiableFiles(task).map(pathLine).join("\n"),
        "",
        "## Read-only files",
        "",
        readableSection,
    ].join("\n");
    writeFileSync(briefFile, content);
    return briefFile;
}
```
This satisfies brief item 1: modifiable paths under their own heading, read-only paths under
another, no file bodies, and the `(missing: file not found on disk)` note preserved for any
declared path (modifiable or read-only) that does not exist on disk.

Lines 156-175, replace `buildWorkflowArguments` in full:
```
export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => ({
            number,
            briefFile: join(repoRoot, "plans", `brief-${number}.md`),
            planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
            files: group.filePaths,
        })),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}
```
with:
```
export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
    tasks: TaskRecord[] = [],
): WorkflowArguments {
    const taskByNumber = new Map(tasks.map((task) => [task.taskNumber, task]));
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => {
            const sourceTask = taskByNumber.get(number);
            return {
                number,
                briefFile: join(repoRoot, "plans", `brief-${number}.md`),
                planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
                modifiableFiles: group.filePaths,
                readOnlyFiles: sourceTask ? readOnlyFiles(sourceTask) : ["*"],
            };
        }),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}
```
Each prepared task's `readOnlyFiles` comes only from that task's own record, never from any
sibling task in the same group — a task with `["*"]` (or an explicit list) never widens or
narrows another task's read fence. `modifiableFiles` keeps using the group's aggregated
`filePaths` as before, since edit-scope aggregation to the worktree boundary is unaffected by
this fix.

Line 212, inside `runAsCli`, pass the already-in-scope `tasks` variable as the new 4th argument:
```
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
```
→
```
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups, tasks);
```

No other lines in this file change.

### scripts/approvalGate.ts (103 lines → 104 lines)

Line 12, add the new optional field right after `files: string[];`:
```
export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    operationRef: string;
```
→
```
export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    readOnlyFiles?: string[];
    operationRef: string;
```
No other lines in this file change. `files` keeps its existing name and required-ness, so
`tests/approvalGate.test.ts`'s three call sites (lines 16, 61, 138), none of which set
`readOnlyFiles`, keep compiling and keep passing unchanged — an omitted optional property is
simply absent from `stableStringify`'s `Object.keys` walk over the input object.

### scripts/mergePipeline.ts (249 lines → 251 lines)

Line 141, update the source of the digest's `files` list — `PreparedTask.files` no longer
exists after the `prepareTasks.ts` edit above, so this line must change to compile, independent
of the `approvalGate.ts` edit:
```
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];
```
→
```
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.modifiableFiles)))];
    const readOnlyFilePaths = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.readOnlyFiles));
    const readOnlyFiles = readOnlyFilePaths.includes("*") ? ["*"] : [...new Set(readOnlyFilePaths)];
```
Line 144, add the new field to the constructed digest input:
```
    const digestInput: ApprovalDigestInput = { manifest, files, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };
```
→
```
    const digestInput: ApprovalDigestInput = { manifest, files, readOnlyFiles, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };
```
No other lines in this file change; the local variable `files` stays named `files` because
`ApprovalDigestInput.files` (consumed two lines later, unchanged) still expects that name, and
the new local `readOnlyFiles` shares its name with the digest field it fills, the same
convention `files` already follows.

### skills/tackle-tasks/plan.workflow.js (87 lines → ~91 lines)

Insert a helper immediately before line 26 (`const plannerBrief = ...`):
```js
// ponytail: read-scope text duplicated per file, same reason as retryAgent below.
const readScope = (t) => t.readOnlyFiles.includes('*')
  ? 'every file in the project'
  : [...new Set([...t.modifiableFiles, ...t.readOnlyFiles])].join(', ')

```

Inside `plannerBrief`, four edits:
- Line 28: `You may also READ these owned files, and nothing else: ${t.files.join(', ')}` → `You may also READ ${readScope(t)}, and nothing else.`
- Line 35: `- Account for every owned file: either its exact edit list, or the reason it needs no edit.` → `- Account for every modifiable file: either its exact edit list, or the reason it needs no edit.`
- Line 44: `If the plan would need to edit a file outside the owned list above, set status` → `If the plan would need to edit a file outside modifiableFiles (${t.modifiableFiles.join(', ')}), set status`
- Lines 52-53:
```
You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
```
→
```
You are forbidden to edit any file other than ${t.planFile}; to read anything outside
the brief file, ~/.claude/guides/planning.md, and ${readScope(t)}; to leave a decision
for the implementer; or to write a plan step
```
This keeps the planner's two required reads (its brief file, line 27; the planning guide,
line 30) explicitly permitted, rather than contradicting them with a bare "nothing outside
${readScope(t)}".
No other lines change.

### skills/tackle-tasks/implement.workflow.js (143 lines → ~148 lines)

Insert a helper immediately before line 29 (`const workerBrief = ...`):
```js
// ponytail: read-scope text duplicated per file, same reason as retryAgent below.
const readScope = (t) => t.readOnlyFiles.includes('*')
  ? 'every file in the project'
  : [...new Set([...t.modifiableFiles, ...t.readOnlyFiles])].join(', ')

```

Inside `workerBrief`:
- Line 38: `ownedFiles = ${t.files.join(', ')}` →
```
modifiableFiles = ${t.modifiableFiles.join(', ')}
readableFiles = ${readScope(t)}
```
- Line 49: `implement every step of the plan, editing only ownedFiles` → `implement every step of the plan, editing only modifiableFiles; you may read readableFiles for context`
- Line 52: `if typecheck reported errors in ownedFiles:` → `if typecheck reported errors in modifiableFiles:`
- Lines 55-58:
```
if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
```
→
```
if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering modifiableFiles
else:
    tests = the test file belonging to each file in modifiableFiles
```
- Line 73: `` run: ${t.files.length ? `git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}` : 'git add -- (every path you edited, listed explicitly)'} `` → `` run: ${t.modifiableFiles.length ? `git add -- ${t.modifiableFiles.map((f) => JSON.stringify(f)).join(' ')}` : 'git add -- (every path you edited, listed explicitly)'} ``
- Line 84: `You are forbidden to touch anything outside ownedFiles; to add scope or` → `You are forbidden to edit or git-add anything outside modifiableFiles; to add scope or`
  (using "edit or git-add" instead of the ambiguous "touch" so the prohibition targets writes
  only — line 49 already permits reading `readableFiles` for context, which "touch" would
  otherwise contradict)
No other lines change.

### skills/tackle-tasks/test.workflow.js (169 lines → ~180 lines)

Insert two helpers immediately before line 42 (`const testerBrief = ...`):
```js
// ponytail: read-scope text duplicated per file, same reason as retryAgent below.
const readScope = (t) => t.readOnlyFiles.includes('*')
  ? 'every file in the project'
  : [...new Set([...t.modifiableFiles, ...t.readOnlyFiles])].join(', ')

// ponytail: read-scope text duplicated per file, same reason as retryAgent below. Group variant: testerBrief covers every task in the group at once, not one task at a time.
const readScopeForTasks = (tasks) => tasks.some((t) => t.readOnlyFiles.includes('*'))
  ? 'every file in the project'
  : [...new Set(tasks.flatMap((t) => [...t.modifiableFiles, ...t.readOnlyFiles]))].join(', ')

```

Inside `testerBrief`:
- Lines 48-50:
```
ownedFiles = {
${tasks.map((t) => `    task ${t.number}: ${t.files.join(', ')}`).join('\n')}
}
```
→
```
modifiableFiles = {
${tasks.map((t) => `    task ${t.number}: ${t.modifiableFiles.join(', ')}`).join('\n')}
}
readableFiles = ${readScopeForTasks(tasks)}
```
- Lines 55-58:
```
if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
```
→
```
if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering modifiableFiles
else:
    tests = the test file belonging to each file in modifiableFiles
```
- Line 63: `for each task in ownedFiles:` → `for each task in modifiableFiles:`
- Line 72: `You are forbidden to edit any file, to run the full suite, or to report passed` → `You are forbidden to edit any file, to read anything outside readableFiles, to run the full suite, or to report passed`

Inside `fixerBrief`:
- Line 86: `ownedFiles = ${t.files.join(', ')}` →
```
modifiableFiles = ${t.modifiableFiles.join(', ')}
readableFiles = ${readScope(t)}
```
- Line 101: `results = run(the tests covering ownedFiles)` → `results = run(the tests covering modifiableFiles)`
- Line 104: `` run: git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')} `` → `` run: git add -- ${t.modifiableFiles.map((f) => JSON.stringify(f)).join(' ')} ``
- Line 110: `You are forbidden to touch anything outside ownedFiles; to weaken, skip, or` → `You are forbidden to edit or git-add anything outside modifiableFiles; to weaken, skip, or`
  (same "edit or git-add" wording as `implement.workflow.js`, so the prohibition does not
  contradict the permitted read of `readableFiles` two lines above)
No other lines change. (`tasks[0]` is safe inside `testerBrief` because `testGroup` only calls
it after confirming `tasks.length` is at least 1; `readScopeForTasks` reduces to `readScope`'s
own logic when there is exactly one task, so `readableFiles` in `testerBrief` and `fixerBrief`
agree for a single-task group.)

### skills/tackle-tasks/verify.workflow.js (122 lines, unchanged count)

Line 25, inside `codexPrompt`:
```
Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.
```
→
```
Decide whether the plan is good enough to hand to an implementer: it stays within the task's modifiable files (${t.modifiableFiles.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.
```
No other lines change — the verifier only ever reads the brief and plan files, never the
project source, so there is no separate read-fence sentence to add here.

### skills/create-task/template/taskTemplate.json (11 lines → 11 lines)

Replace the whole file:
```json
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
  "userDescription": "<$ARGUMENTS verbatim, exactly as typed — never edited, summarized, or reworded>",
  "description": "<only the agent's derived, fleshed-out understanding: file paths, line numbers, root-cause findings, constraints, and decisions gathered while writing the task; must not restate the raw prompt>",
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
}
```
with:
```json
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
  "userDescription": "<$ARGUMENTS verbatim, exactly as typed — never edited, summarized, or reworded>",
  "description": "<only the agent's derived, fleshed-out understanding: file paths, line numbers, root-cause findings, constraints, and decisions gathered while writing the task; must not restate the raw prompt>",
  "modifiableFiles": ["<repo-relative path this task will touch>"],
  "readOnlyFiles": ["<repo-relative path this task may read but not edit; omit the field, or use [\"*\"], to mean every file in the project is readable>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
}
```

### skills/create-task/SKILL.md (32 lines → 32 lines)

Line 23:
```
Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.
```
→
```
Populate `modifiableFiles` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing. Populate `readOnlyFiles` with any additional repo-relative paths the task's agents need to read but not edit; omit the field (or set it to `["*"]`) to mean every file in the project is readable, which is also the default when a task predates this field.
```
No other lines change.

### skills/update-task-files/SKILL.md (71 lines → 71 lines)

Line 2 (frontmatter `description`):
```
description: backfill the `files` array on existing tasks in tasks.json so they can be planned and implemented by tackle-tasks. Use when tackle-tasks refuses a task for declaring no files, or when auditing tasks created before the field existed.
```
→
```
description: backfill the `modifiableFiles` array on existing tasks in tasks.json so they can be planned and implemented by tackle-tasks. Use when tackle-tasks refuses a task for declaring no modifiableFiles, or when auditing tasks created before the field existed.
```

Line 12:
```
Add a `files` array to each task shown above, inserted after `description`. If a task
already has one, verify it against the current codebase rather than rewriting it.
```
→
```
For each task shown above: if it already has `modifiableFiles`, verify it against the current
codebase rather than rewriting it. Otherwise, if it has the legacy `files` key, rename that key
to `modifiableFiles` in place (same array, same position) and then verify it. Otherwise, add a
new `modifiableFiles` array, inserted after `description`. Leave `readOnlyFiles` absent —
the default of every project file being readable — unless the task genuinely needs a narrower
read fence, in which case add an explicit `readOnlyFiles` array naming only the paths it needs.
```

Lines 46-49:
```
If a task is too vague to determine its files, leave that task's `files` field out and
report its number. A wrong list is worse than no list: the task will simply be refused
again, which is the correct outcome for a task that needs rethinking rather than
annotating.
```
→
```
If a task is too vague to determine its files, leave that task's `modifiableFiles` field out and
report its number. A wrong list is worse than no list: the task will simply be refused
again, which is the correct outcome for a task that needs rethinking rather than
annotating.
```

Lines 69-70:
```
A table of task number to files, then a separate list of the task numbers you left without
a `files` field, each with the reason it could not be determined.
```
→
```
A table of task number to files, then a separate list of the task numbers you left without
a `modifiableFiles` field, each with the reason it could not be determined.
```
No other lines change.

### skills/close-tasks/SKILL.md (25 lines → 27 lines)

Insert a new paragraph after line 18 (`Skip tasks already COMPLETED or not found, and say so.`)
and before line 20 (`Then unblock dependents with one run of ...`):
```
On every invocation, before staging, migrate every task left in `tasks.json` — not just the
tasks being closed this run: if a task has a legacy `files` key and no `modifiableFiles` key,
rename `files` to `modifiableFiles` in place (same array, same position). If a task has both
keys, keep `modifiableFiles` as authoritative and delete the legacy `files` key, discarding its
value. This drains the legacy key out over time even though readers still accept it. Leave
every other field, value, and task order untouched.
```
No other lines change.

## Test files

### tests/taskGroups.test.ts (79 lines → ~119 lines)

Line 4, add the two new accessors to the import:
```
import { groupTasksByFileOverlap } from "../scripts/taskGroups.ts";
```
→
```
import { groupTasksByFileOverlap, modifiableFiles, readOnlyFiles } from "../scripts/taskGroups.ts";
```

Append these 7 tests after the last existing test (after line 79), each as a bare object
literal assigned to a `const` first (matching this file's existing `task()` helper pattern,
which already relies on `TaskRecord`'s only required field being `taskNumber`, so no type
casts are needed):
```ts
test("test_modifiableFilesReadsTheNewKeyWhenPresent", () => {
    const t = { taskNumber: 1, modifiableFiles: ["a.ts"], files: ["ignored.ts"] };
    assert.deepEqual(modifiableFiles(t), ["a.ts"]);
});

test("test_modifiableFilesFallsBackToTheLegacyFilesKeyWhenNewKeyIsAbsent", () => {
    const t = { taskNumber: 2, files: ["c.ts"] };
    assert.deepEqual(modifiableFiles(t), ["c.ts"]);
});

test("test_readOnlyFilesReadsTheDeclaredArrayWhenPresent", () => {
    const t = { taskNumber: 1, files: ["a.ts"], readOnlyFiles: ["b.ts"] };
    assert.deepEqual(readOnlyFiles(t), ["b.ts"]);
});

test("test_readOnlyFilesDefaultsToWildcardWhenTheKeyIsMissing", () => {
    const t = { taskNumber: 1, files: ["a.ts"] };
    assert.deepEqual(readOnlyFiles(t), ["*"]);
});

test("test_readOnlyFilesCollapsesAMixedWildcardDeclarationToJustTheWildcard", () => {
    const t = { taskNumber: 1, readOnlyFiles: ["*", "extra.ts"] };
    assert.deepEqual(readOnlyFiles(t), ["*"]);
});

test("test_groupTasksByFileOverlapGroupsANewStyleTaskAndALegacyTaskIdenticallyWhenTheyShareAFile", () => {
    const newStyleTask = { taskNumber: 1, modifiableFiles: ["shared.ts"], readOnlyFiles: ["ctx.ts"] };
    const legacyTask = { taskNumber: 2, files: ["shared.ts"] };
    const groups = groupTasksByFileOverlap([newStyleTask, legacyTask], flatManifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
    assert.deepEqual(groups[0].filePaths, ["shared.ts"]);
});

test("test_groupTasksByFileOverlapWithNoManifestGroupsANewStyleTaskAndALegacyTaskIdenticallyWhenTheyShareAFile", () => {
    const newStyleTask = { taskNumber: 1, modifiableFiles: ["shared.ts"] };
    const legacyTask = { taskNumber: 2, files: ["shared.ts"] };
    const groups = groupTasksByFileOverlap([newStyleTask, legacyTask]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});
```
The second-to-last test exercises the production grouping path (`flatManifest` is passed, so
`groupTasksByFileOverlap` calls `buildCanonicalTaskGroups`, which calls `declaredFiles` —
now the modifiableFiles-aware alias — proving the new key propagates into the unowned
grouping code for free). The last test exercises the manifest-free fallback path that lives
directly in this file.

### tests/prepareTasks.test.ts (234 lines → ~243 lines)

Replace the test at lines 46-55 (rename it and switch its assertions to match the new
pointer-list brief format instead of the old embedded-contents format):
```ts
test("test_writeTaskBriefFileEmbedsTheDeclaredFileContents", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /MARKER-abc123/);
});
```
with:
```ts
test("test_writeTaskBriefFilePointsAtModifiableFilesWithoutEmbeddingContents", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /## Modifiable files[\s\S]*fileA\.txt/);
    assert.match(text, /## Read-only files[\s\S]*\[\*\]/);
    assert.doesNotMatch(text, /MARKER-abc123/);
});
```
This one test now covers: a legacy task declaring only `files` still resolves through the
shared accessor, the brief lists the file's path (not its body), and an omitted
`readOnlyFiles` renders as the `[*]` wildcard.

Insert a new test immediately after it (before `test_writeTaskBriefFileOmitsMissingFilesWithoutThrowing`):
```ts
test("test_writeTaskBriefFileListsReadOnlyFilesUnderTheirOwnHeading", () => {
    const repoRoot = makeTempRepoWithCommit();
    const task = { taskNumber: 3, description: "d3", modifiableFiles: ["editable.ts"], readOnlyFiles: ["readable.ts"] };
    const text = readFileSync(writeTaskBriefFile(task, repoRoot), "utf8");
    assert.match(text, /## Read-only files[\s\S]*readable\.ts/);
});
```
This covers a task declaring the new `modifiableFiles`/`readOnlyFiles` keys directly, proving
both keys are read and the read-only path lands under its own heading.

Replace the test at lines 123-130 (extend it to also prove the wildcard default, satisfying
"the task omitting readOnlyFiles is treated as [*]" at the `buildWorkflowArguments` level):
```ts
test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [268, 270], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const tasks = workflowArguments.groups[0].tasks;
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});
```
with:
```ts
test("test_buildWorkflowArgumentsDictatesThePlanFilePathAndDefaultsReadOnlyFilesToWildcard", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [268, 270], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const tasks = workflowArguments.groups[0].tasks;
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
    assert.deepEqual(tasks.find((t) => t.number === 268)!.readOnlyFiles, ["*"]);
});
```
This keeps using the existing 3-argument call (no `tasks` array given), proving the
backward-compatible default path resolves to `["*"]`.

Insert a new test immediately after it:
```ts
test("test_buildWorkflowArgumentsKeepsEachTasksReadOnlyFilesSeparateWithinAGroup", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1, 2], filePaths: ["a.ts", "b.ts"], scope: "declared" }];
    const tasks = [
        { taskNumber: 1, files: ["a.ts"], readOnlyFiles: ["ctx.ts"] },
        { taskNumber: 2, files: ["b.ts"], readOnlyFiles: ["*"] },
    ];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups, tasks);
    const preparedTasks = workflowArguments.groups[0].tasks;
    assert.deepEqual(preparedTasks.find((t) => t.number === 1)!.readOnlyFiles, ["ctx.ts"]);
    assert.deepEqual(preparedTasks.find((t) => t.number === 2)!.readOnlyFiles, ["*"]);
});
```
Both tasks share a group (and would share a worktree, hence share `modifiableFiles`), but
task 2's `["*"]` must not widen task 1's `readOnlyFiles` — this is the case design decision 5
above exists to prevent. No type cast is needed on the `tasks` array literal, matching this
file's other plain-object task literals (e.g. the existing `selectRequestedTasks` tests).

No other lines in this file change.

### tests/prepareTasksIntegration.test.ts — no edit

`buildWorkflowArguments`'s new 4th parameter (`tasks: TaskRecord[] = []`) is optional, so the
existing 3-argument call in this file (inside the spawned `bun -e` script) continues to compile
and pass unchanged. This file's only assertion on the result (`built.groups.length > 0`) does
not touch `.files`/`.modifiableFiles`/`.readOnlyFiles`, so nothing here needs to change.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. `npx tsc --noEmit`
   Expected: exits 0, no type errors (proves every renamed/removed field and every new
   `TaskRecord`-adjacent cast typechecks, including the three unowned files that still import
   `declaredFiles` from `scripts/taskGroups.ts`).

2. `node --test tests/`
   Expected: all tests pass, 0 failures — including `tests/approvalGate.test.ts`,
   `tests/reflowComments.test.ts`, and `tests/reflow-comments-post.test.ts`, none of which this
   plan edits, proving nothing outside the owned files broke.

3. `node --test tests/taskGroups.test.ts`
   Expected: `# pass 13`, `# fail 0` (6 existing tests + 7 new tests from this plan).

4. `node --test tests/prepareTasks.test.ts`
   Expected: `# pass 23`, `# fail 0` (21 existing tests, one renamed/extended, one replaced,
   plus 2 new tests).

5. `node --test tests/prepareTasksIntegration.test.ts`
   Expected: `# pass 4`, `# fail 0` (unchanged from before this plan).

6. `node --test tests/approvalGate.test.ts`
   Expected: all existing tests still pass unchanged, proving the new optional
   `readOnlyFiles?: string[]` field on `ApprovalDigestInput` does not affect any digest this
   file's tests compute (none of them set that field).

7. `rg -n '"modifiableFiles"' skills/create-task/template/taskTemplate.json skills/create-task/SKILL.md skills/update-task-files/SKILL.md skills/close-tasks/SKILL.md`
   Expected: at least one match in each of the four files, confirming the task-authoring
   surfaces were updated.

8. `rg -n '"files"' skills/create-task/template/taskTemplate.json`
   Expected: no match, confirming the template's key was fully replaced (not left as a
   duplicate alongside `modifiableFiles`).
