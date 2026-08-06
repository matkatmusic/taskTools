# Task 58 plan: split task file ownership into modifiableFiles and readOnlyFiles

Source of truth for every edit below is the live file content read directly from disk
during planning (confirmed byte-identical to the copies quoted in `plans/brief-58.md`).
Line numbers are the current line numbers in each file, before any edit in this plan is
applied; edits within the same file are listed top-to-bottom so line numbers stay valid
as you apply them in order.

## Design decisions this plan makes (not left open)

1. **Where the shared accessor pair lives.** `scripts/prepareTasks.ts` already imports
   from `scripts/taskGroups.ts` (for `TaskGroup`, `TaskGroupScope`, `groupTasksByFileOverlap`),
   and `scripts/taskGroups.ts` does not import from `scripts/prepareTasks.ts` — so putting
   the pair in `taskGroups.ts` and having `prepareTasks.ts` import it avoids a circular
   import. The pair is exported as `modifiableFiles` and `readOnlyFiles`.

2. **Backward-compatible export name.** `scripts/taskGroups.ts` currently exports
   `declaredFiles`, a name outside the owned-file list (e.g. `scripts/canonicalTaskGroups.ts`,
   which `taskGroups.ts` imports `buildCanonicalTaskGroups` from) may already import by that
   name. The plan keeps `declaredFiles` exported as an alias of the new `modifiableFiles`
   function (`export { modifiableFiles as declaredFiles };`) so any such caller keeps
   working and transparently gains the new `task.modifiableFiles`-first fallback, with zero
   edits to files outside the owned list.

3. **`TaskRecord` accepts arbitrary keys.** `scripts/taskFiles.ts` (not owned, not read) is
   never accessed with a narrower type than `TaskRecord`. The owned files already compile
   today while reading `task.files`, `task.blockedBy`, `task.tests`, `task.difficulty`, and
   `task.handoffFilePaths` as plain property access with no per-field declarations visible
   in any owned file, and `scripts/viewTaskHook.ts` iterates `Object.entries(task)`
   generically. This is only possible if `TaskRecord` carries a permissive index signature.
   The plan relies on that: `task.modifiableFiles` and `task.readOnlyFiles` type-check the
   same way `task.files` already does.

4. **`buildWorkflowArguments` needs a new optional parameter.** `PreparedTask.files` is
   currently populated from `group.filePaths` (the group's already-merged file list), not
   from the originating task's own record — `TaskGroup` never carries the individual
   `TaskRecord` objects, only `taskNumbers` and merged `filePaths`. There is no way to read
   a given task's own `readOnlyFiles` without access to that task's `TaskRecord`. So
   `buildWorkflowArguments` gains a 4th parameter, `tasks: TaskRecord[] = []`, defaulting to
   `[]` so every existing 3-argument call site (all in the owned test files) keeps compiling
   and keeps behaving identically (falls back to `readOnlyFiles: ["*"]` for every task, which
   is the documented default). The one production call site, inside `runAsCli()`, is updated
   to pass the already-in-scope `tasks` array.

## scripts/taskGroups.ts

**Edit 1** — replace the `declaredFiles` function (current lines 15-17) with the shared pair
plus a compatibility alias.

Current (lines 15-17):
```
export function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}
```

New:
```
export function modifiableFiles(task: TaskRecord): string[] {
    if (Array.isArray(task.modifiableFiles)) return task.modifiableFiles as string[];
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

export { modifiableFiles as declaredFiles };

export function readOnlyFiles(task: TaskRecord): string[] {
    return Array.isArray(task.readOnlyFiles) ? (task.readOnlyFiles as string[]) : ["*"];
}
```

**Edit 2** — line 32 (inside `groupTasksByExactFileOverlapWithNoManifest`):
Current: `        for (const file of declaredFiles(task)) {`
New: `        for (const file of modifiableFiles(task)) {`

**Edit 3** — line 38:
Current: `    const unknownTasks = tasks.filter((task) => declaredFiles(task).length === 0);`
New: `    const unknownTasks = tasks.filter((task) => modifiableFiles(task).length === 0);`

**Edit 4** — line 51:
Current: `        const filePaths = [...new Set(members.flatMap((m) => declaredFiles(m)))].sort();`
New: `        const filePaths = [...new Set(members.flatMap((m) => modifiableFiles(m)))].sort();`

No other line in this file references `declaredFiles` or `.files`.

## scripts/prepareTasks.ts

**Edit 1** — line 3 import (drop `readFileSync`, no longer used once `writeTaskBriefFile` is
rewritten in Edit 6; confirmed by grep that line 109 is `readFileSync`'s only use in this
file):
Current: `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`
New: `import { existsSync, mkdirSync, writeFileSync } from "node:fs";`

**Edit 2** — line 9 import:
Current: `import { groupTasksByFileOverlap } from "./taskGroups.ts";`
New: `import { groupTasksByFileOverlap, modifiableFiles, readOnlyFiles } from "./taskGroups.ts";`

**Edit 3** — `PreparedTask` type, lines 13-18:
Current:
```
export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    files: string[];
};
```
New:
```
export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    modifiableFiles: string[];
    readOnlyFiles: string[];
};
```

**Edit 4** — line 54 (inside `selectRequestedTasks`):
Current: `    const undeclaredNumbers = runnableTasks.filter((task) => declaredFiles(task).length === 0).map((task) => task.taskNumber);`
New: `    const undeclaredNumbers = runnableTasks.filter((task) => modifiableFiles(task).length === 0).map((task) => task.taskNumber);`

**Edit 5** — lines 57-61, the thrown error inside `selectRequestedTasks` (wording updated so
it points at the now-canonical key instead of the legacy one; `update-task-files` will emit
`modifiableFiles` after this task's Edit in that skill, below):
Current:
```
        throw new Error(
            `these tasks declare no "files" and cannot be planned or implemented: ${numbers}. `
            + `A task's "files" array is both the worker's ownership fence and the key that decides `
            + `what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
        );
```
New:
```
        throw new Error(
            `these tasks declare no "modifiableFiles" and cannot be planned or implemented: ${numbers}. `
            + `A task's "modifiableFiles" array (or the legacy "files" key) is both the worker's ownership fence `
            + `and the key that decides what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
        );
```

**Edit 6** — lines 99-120: delete the local `declaredFiles` function and rewrite
`writeTaskBriefFile` to write pointer lists instead of embedding file contents.

Current:
```
function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

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
        task.description ?? "",
        "",
        ...fileSections,
    ].join("\n");
    writeFileSync(briefFile, content);
    return briefFile;
}
```
New:
```
export function writeTaskBriefFile(task: TaskRecord, repoRoot: string): string {
    const briefFile = join(repoRoot, "plans", `brief-${task.taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    const pointerLine = (file: string): string => {
        if (file === "*") return "- * (every file in the project is readable)";
        return existsSync(join(repoRoot, file)) ? `- ${file}` : `- ${file} (missing: file not found on disk)`;
    };
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        task.description ?? "",
        "",
        "## Modifiable files",
        "",
        ...modifiableFiles(task).map(pointerLine),
        "",
        "## Readable files",
        "",
        ...readOnlyFiles(task).map(pointerLine),
    ].join("\n");
    writeFileSync(briefFile, content);
    return briefFile;
}
```

**Edit 7** — `buildWorkflowArguments`, lines 155-173 (adds the 4th parameter described in
design decision 4, and threads `readOnlyFiles` per task):
Current:
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
New:
```
export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
    tasks: TaskRecord[] = [],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const taskByNumber = new Map(tasks.map((task) => [task.taskNumber, task]));
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => ({
            number,
            briefFile: join(repoRoot, "plans", `brief-${number}.md`),
            planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
            modifiableFiles: group.filePaths,
            readOnlyFiles: taskByNumber.has(number) ? readOnlyFiles(taskByNumber.get(number)!) : ["*"],
        })),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}
```

**Edit 8** — line 199, inside `runAsCli()` (pass the already-selected `tasks` through):
Current: `    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);`
New: `    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups, tasks);`

## scripts/approvalGate.ts

**Edit 1** — `ApprovalDigestInput`, line 12 (the `files` field is populated from every
task's modifiable set in `mergePipeline.ts`, so it is renamed for consistency; a new
`readOnlyFiles` field is added alongside it so the approval digest also covers the read
scope; nothing else in this file references `.files`):
Current:
```
export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    operationRef: string;
```
New:
```
export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    modifiableFiles: string[];
    readOnlyFiles: string[];
    operationRef: string;
```

## scripts/mergePipeline.ts

**Edit 1** — line 141 (`task.files` → `task.modifiableFiles`, matching Edit 3 of
`prepareTasks.ts` above; the local `const files` is also renamed to keep the property-
shorthand construction on line 144 correct). A second line is added right after it that
flattens every task's `readOnlyFiles` into one union, canonicalizing to `["*"]` whenever
any task's read scope is the wildcard (since `["*"]` unioned with any other list still
means "the whole project is readable" — a partial list must never shadow that):
Current: `    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];`
New:
```
    const modifiableFiles = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.modifiableFiles)))];
    const readOnlyFilesUnion = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.readOnlyFiles));
    const readOnlyFiles = readOnlyFilesUnion.includes("*") ? ["*"] : [...new Set(readOnlyFilesUnion)];
```

**Edit 2** — line 144 (matches the `ApprovalDigestInput.modifiableFiles`/`readOnlyFiles`
rename and addition above):
Current: `    const digestInput: ApprovalDigestInput = { manifest, files, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };`
New: `    const digestInput: ApprovalDigestInput = { manifest, modifiableFiles, readOnlyFiles, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };`

No other line in this file references `.files`.

## scripts/repositoryDiscovery.ts — no edit

This file discovers the nested-submodule repository tree (occurrence IDs, base branches,
gitlink OIDs). It has no reference to `task.files`, `modifiableFiles`, `readOnlyFiles`, or
any task-ownership concept; confirmed by direct read, nothing in it needs to change for this
task.

## scripts/viewTaskHook.ts — no edit

`formatTask` already renders every task field generically: it special-cases only
`taskNumber`, `title`, and `description`, then loops `Object.entries(task)` for everything
else, printing array fields as bulleted sub-lists. Once tasks carry `modifiableFiles` and
`readOnlyFiles` keys instead of (or alongside) `files`, this loop displays them automatically
with no code change.

## skills/tackle-tasks/plan.workflow.js

**Edit 1** — line 28, split the single read-only line into an edit-fence line and a
read-fence line:
Current: `You may also READ these owned files, and nothing else: ${t.files.join(', ')}`
New:
```
You may EDIT these files, and nothing else: ${t.modifiableFiles.join(', ')}
You may also READ these files: ${t.readOnlyFiles.length === 1 && t.readOnlyFiles[0] === '*' ? 'every file in the project' : t.readOnlyFiles.join(', ')}
```

**Edit 2** — line 29 (now reads two lists, not one):
Current: `Read them — a plan that guesses at their contents will be rejected by the reviewer.`
New: `Read both sets — a plan that guesses at their contents will be rejected by the reviewer.`

**Edit 3** — line 35:
Current: `- Account for every owned file: either its exact edit list, or the reason it needs no edit.`
New: `- Account for every modifiable file: either its exact edit list, or the reason it needs no edit.`

**Edit 4** — line 44:
Current: `If the plan would need to edit a file outside the owned list above, set status`
New: `If the plan would need to edit a file outside the modifiable list above, set status`

**Edit 5** — lines 52-53:
Current:
```
You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
```
New:
```
You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the modifiable or readable lists above; to leave a decision for the implementer; or to write a plan step
```

## skills/tackle-tasks/implement.workflow.js

**Edit 1** — line 38, add a `readableFiles` line using the same wildcard rendering as
`plan.workflow.js` Edit 1:
Current: `ownedFiles = ${t.files.join(', ')}`
New:
```
ownedFiles = ${t.modifiableFiles.join(', ')}
readableFiles = ${t.readOnlyFiles.length === 1 && t.readOnlyFiles[0] === '*' ? 'every file in the project' : t.readOnlyFiles.join(', ')}
```

**Edit 2** — line 49, state the read/edit split explicitly:
Current: `implement every step of the plan, editing only ownedFiles`
New: `implement every step of the plan; you may read readableFiles for context, but edit or stage only ownedFiles`

**Edit 3** — line 73:
Current: `    run: ${t.files.length ? \`git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}\` : 'git add -- (every path you edited, listed explicitly)'}`
New: `    run: ${t.modifiableFiles.length ? \`git add -- ${t.modifiableFiles.map((f) => JSON.stringify(f)).join(' ')}\` : 'git add -- (every path you edited, listed explicitly)'}`

**Edit 4** — line 84, first clause of the forbidden-actions sentence:
Current: `You are forbidden to touch anything outside ownedFiles; to add scope or`
New: `You are forbidden to edit or stage anything outside ownedFiles; to read anything outside ownedFiles and readableFiles; to add scope or`

No other line in this file references `t.files`.

## skills/tackle-tasks/test.workflow.js

**Edit 1** — line 49, list each task's readable files alongside its modifiable ones (same
wildcard rendering as `plan.workflow.js` Edit 1):
Current: `${tasks.map((t) => \`    task ${t.number}: ${t.files.join(', ')}\`).join('\n')}`
New: `${tasks.map((t) => \`    task ${t.number}: modifiable=${t.modifiableFiles.join(', ')}; readable=${t.readOnlyFiles.length === 1 && t.readOnlyFiles[0] === '*' ? 'every file in the project' : t.readOnlyFiles.join(', ')}\`).join('\n')}`

**Edit 2** — line 86, add a `readableFiles` line:
Current: `ownedFiles = ${t.files.join(', ')}`
New:
```
ownedFiles = ${t.modifiableFiles.join(', ')}
readableFiles = ${t.readOnlyFiles.length === 1 && t.readOnlyFiles[0] === '*' ? 'every file in the project' : t.readOnlyFiles.join(', ')}
```

**Edit 3** — line 104:
Current: `    run: git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}`
New: `    run: git add -- ${t.modifiableFiles.map((f) => JSON.stringify(f)).join(' ')}`

**Edit 4** — line 110, first clause of the forbidden-actions sentence in `fixerBrief`:
Current: `You are forbidden to touch anything outside ownedFiles; to weaken, skip, or`
New: `You are forbidden to edit or stage anything outside ownedFiles; to read anything outside ownedFiles and readableFiles; to weaken, skip, or`

No other line in this file references `t.files`.

## skills/tackle-tasks/verify.workflow.js

**Edit 1** — lines 23-31, the whole `codexPrompt` template literal. Since briefs no longer
embed file contents (Edit 6 of `scripts/prepareTasks.ts` above), telling the reviewer to
"read only these two files" would leave it unable to check the plan against real code — this
edit lets it read the task's own modifiable and readable files too, and states the
edit/read split explicitly:
Current:
```
const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`
```
New:
```
const codexPrompt = (t, planFile) => `Review an implementation plan. Read the brief ${t.briefFile} and the plan ${planFile}, plus any of the task's own modifiable or readable files you need in order to check the plan against the real code. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's modifiable files (${t.modifiableFiles.join(', ')}) — only those may be edited or staged, while its readable files (${t.readOnlyFiles.length === 1 && t.readOnlyFiles[0] === '*' ? 'every file in the project' : t.readOnlyFiles.join(', ')}) may be read but not edited — it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's modifiable files, say so explicitly in FIXES instead of inventing a fix.`
```

**Edit 2** — line 78, for wording consistency with Edit 1 above (this line does not read the
`.files` property, so it is a prose-only change):
Current: `  If the reviewer said the plan cannot be fixed within the task's owned files, do`
New: `  If the reviewer said the plan cannot be fixed within the task's modifiable files, do`

No other line in this file references `t.files`.

## skills/create-task/template/taskTemplate.json

**Edit 1** — replace the `files` line with two lines for the two new keys:
Current:
```
  "files": ["<repo-relative path this task will touch>"],
```
New:
```
  "modifiableFiles": ["<repo-relative path this task will edit>"],
  "readOnlyFiles": ["<repo-relative path this task needs to read but not edit, or '*' for the whole project; omit the field to default to ['*']>"],
```

## skills/create-task/SKILL.md

**Edit 1** — line 21:
Current: `Populate \`files\` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.`
New:
```
Populate `modifiableFiles` with the repo-relative paths the task will edit, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

Populate `readOnlyFiles` with any additional repo-relative paths the task needs to read but must not edit. Omit the field — it defaults to `["*"]`, meaning the whole project is readable — when the task needs no narrower read scope.
```

## skills/update-task-files/SKILL.md

**Edit 1** — frontmatter `description`, line 3:
Current: `description: backfill the \`files\` array on existing tasks in tasks.json so they can be planned and implemented by tackle-tasks. Use when tackle-tasks refuses a task for declaring no files, or when auditing tasks created before the field existed.`
New: `description: backfill the \`modifiableFiles\` array (and \`readOnlyFiles\` when useful) on existing tasks in tasks.json so they can be planned and implemented by tackle-tasks. Use when tackle-tasks refuses a task for declaring no files, or when auditing tasks created before the field existed.`

**Edit 2** — lines 12-13:
Current:
```
Add a `files` array to each task shown above, inserted after `description`. If a task
already has one, verify it against the current codebase rather than rewriting it.
```
New:
```
Add a `modifiableFiles` array to each task shown above, inserted after `description`. If a task
already has one — under that name or the legacy `files` key — verify it against the current codebase
rather than rewriting it.

Add a `readOnlyFiles` array after `modifiableFiles` only when the task needs to read paths beyond its
own `modifiableFiles`. Omit it to default to `["*"]`, meaning the whole project is readable.
```

**Edit 3** — lines 33-34:
Current:
```
1. **Ownership fence.** The worker implementing the task is told "touch nothing outside
   them". Under-declaring blocks the worker from files it needs.
```
New:
```
1. **Ownership fence.** The worker implementing the task is told "touch nothing outside
   modifiableFiles". Under-declaring blocks the worker from files it needs to edit; files it only
   needs to read belong in `readOnlyFiles` (or the default `["*"]`) instead.
```

**Edit 4** — line 46:
Current: `If a task is too vague to determine its files, leave that task's \`files\` field out and`
New: `If a task is too vague to determine its files, leave that task's \`modifiableFiles\` field out and`

**Edit 5** — lines 69-70:
Current:
```
A table of task number to files, then a separate list of the task numbers you left without
a `files` field, each with the reason it could not be determined.
```
New:
```
A table of task number to modifiableFiles, then a separate list of the task numbers you left without
a `modifiableFiles` field, each with the reason it could not be determined.
```

## skills/close-tasks/SKILL.md

**Edit 1** — insert a migration step between line 12 and line 14:
Current:
```
`$ARGUMENTS` holds the whole invocation, reasoning included, and may attribute reasons per task (`#268 fixed by X, #270 verified by user`).

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.
```
New:
```
`$ARGUMENTS` holds the whole invocation, reasoning included, and may attribute reasons per task (`#268 fixed by X, #270 verified by user`).

On every invocation, first migrate the legacy key across the whole file: for every task object in `tasks.json` — not just the ones you are closing — that has a `files` array, drop `files` from that object; if the object has no `modifiableFiles` array, add one in `files`'s former position holding `files`'s array contents (a rename), otherwise leave the existing `modifiableFiles` array untouched (a straight deletion of the now-redundant legacy key). This drains the legacy key out over time even though readers still accept it.

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.
```

## tests/prepareTasks.test.ts

**Edit 1** — rewrite `test_writeTaskBriefFileEmbedsTheDeclaredFileContents` (lines 46-55, it
asserted the old content-embedding behavior and would now fail) and add one test for the
readable-files heading:
Current:
```
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
New:
```
test("test_writeTaskBriefFilePointsAtDeclaredFilesInsteadOfEmbeddingThem", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /## Modifiable files/);
    assert.match(text, /- fileA\.txt/);
    assert.equal(text.includes("MARKER-abc123"), false);
});

test("test_writeTaskBriefFileListsReadableFilesWithWildcardDefaultAndExplicitOverride", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskWithDefault = { taskNumber: 3, title: "t3", description: "desc", files: ["fileA.txt"] };
    const defaultBrief = readFileSync(writeTaskBriefFile(taskWithDefault, repoRoot), "utf8");
    assert.match(defaultBrief, /## Readable files/);
    assert.match(defaultBrief, /- \* \(every file in the project is readable\)/);

    const taskWithExplicit = { taskNumber: 4, title: "t4", description: "desc", files: ["fileA.txt"], readOnlyFiles: ["fileB.txt"] };
    const explicitBrief = readFileSync(writeTaskBriefFile(taskWithExplicit, repoRoot), "utf8");
    assert.match(explicitBrief, /- fileB\.txt \(missing: file not found on disk\)/);
});
```
(The existing `test_writeTaskBriefFileOmitsMissingFilesWithoutThrowing`, lines 57-64, needs
no edit: it only asserts `/missing\.txt/` and `/missing/i` appear somewhere in the brief,
both still true under the new pointer-line format `- missing.txt (missing: file not found on
disk)`.)

**Edit 2** — append two tests after the file's last test,
`test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch` (lines 227-234):
Current:
```
test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});
```
New:
```
test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});

test("test_buildWorkflowArgumentsDefaultsReadOnlyFilesToWildcardWhenTaskHasNone", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    assert.deepEqual(workflowArguments.groups[0].tasks[0].readOnlyFiles, ["*"]);
    assert.deepEqual(workflowArguments.groups[0].tasks[0].modifiableFiles, ["a.ts"]);
});

test("test_buildWorkflowArgumentsThreadsDeclaredReadOnlyFilesFromTheSourceTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: ["a.ts"], scope: "declared" }];
    const tasks = [{ taskNumber: 1, modifiableFiles: ["a.ts"], readOnlyFiles: ["b.ts", "c.ts"] }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups, tasks);
    assert.deepEqual(workflowArguments.groups[0].tasks[0].readOnlyFiles, ["b.ts", "c.ts"]);
});
```

None of the other 15 existing tests in this file assert on `.files`/`.modifiableFiles`, so
they need no edit; they exercise `selectRequestedTasks`, `createWorktreeForGroup`,
`generateRunId`, `resolveMergeScriptPath`, and the other `buildWorkflowArguments` behaviors
unaffected by this rename (confirmed by reading every test in the file).

## tests/prepareTasksIntegration.test.ts — no edit

Its one `buildWorkflowArguments` call (inside the spawned `bun -e` script in
`test_groupTasksByFileOverlapReturnsRealGroupsInsteadOfThrowing`) uses the 3-argument form,
which still compiles and behaves identically under the new optional 4th parameter, and only
asserts `built.groups.length`, never touching `.files`/`.modifiableFiles`/`.readOnlyFiles`.

## tests/repositoryDiscovery.test.ts — no edit

Covers `discoverRepositoryTree` (submodule tree discovery, branch resolution, operation
branches). Confirmed by direct read: no reference to task files or task ownership anywhere
in this file.

## tests/taskGroups.test.ts

**Edit 1** — append two tests after the file's last test,
`test_groupTasksByFileOverlapStillWorksWithNoManifestArgument` (lines 75-79):
Current:
```
test("test_groupTasksByFileOverlapStillWorksWithNoManifestArgument", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});
```
New:
```
test("test_groupTasksByFileOverlapStillWorksWithNoManifestArgument", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_groupTasksByFileOverlapPrefersModifiableFilesOverLegacyFilesKey", () => {
    const groups = groupTasksByFileOverlap([
        { taskNumber: 1, modifiableFiles: ["fileA"], files: ["fileZ"] },
        { taskNumber: 2, modifiableFiles: ["fileA"] },
    ], flatManifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
    assert.deepEqual(groups[0].filePaths, ["fileA"]);
});

test("test_groupTasksByFileOverlapNeverGroupsOnSharedReadOnlyFiles", () => {
    const groups = groupTasksByFileOverlap([
        { taskNumber: 1, modifiableFiles: ["fileA"], readOnlyFiles: ["shared.ts"] },
        { taskNumber: 2, modifiableFiles: ["fileB"], readOnlyFiles: ["shared.ts"] },
    ], flatManifest);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.taskNumbers), [[1], [2]]);
});
```

The other 5 existing tests in this file all pass legacy `files`-only task objects through
`task(...)` and need no edit — `modifiableFiles`'s fallback to `task.files` keeps their
behavior identical.

## Verification

Run from the repo root, `/Users/matkatmusicllc/Programming/taskTools`:

1. `npx tsc --noEmit`
   Expected: no output, exit code 0 (no type errors from the renamed/added fields).

2. `node --test tests/taskGroups.test.ts tests/prepareTasks.test.ts tests/prepareTasksIntegration.test.ts tests/repositoryDiscovery.test.ts`
   Expected: all tests pass, including the 5 new ones added above (2 in
   `tests/prepareTasks.test.ts`, 2 in `tests/taskGroups.test.ts`, plus the rewritten
   `test_writeTaskBriefFilePointsAtDeclaredFilesInsteadOfEmbeddingThem`), and zero failures
   in the two untouched integration/discovery files.

3. `grep -rn '\.files\b' scripts/prepareTasks.ts scripts/mergePipeline.ts scripts/approvalGate.ts scripts/taskGroups.ts skills/tackle-tasks/plan.workflow.js skills/tackle-tasks/implement.workflow.js skills/tackle-tasks/test.workflow.js skills/tackle-tasks/verify.workflow.js`
   Expected: exactly one match — `scripts/taskGroups.ts`'s `return Array.isArray(task.files) ? (task.files as string[]) : [];`
   fallback line inside `modifiableFiles` (the one intentional legacy-key read this task
   keeps), and no matches in any other file (`.modifiableFiles` and `.readOnlyFiles` do not
   match `\.files\b` themselves, since neither has a literal `.files` substring followed by
   a word boundary).

4. `grep -n 'declaredFiles' scripts/taskGroups.ts`
   Expected: one line — the `export { modifiableFiles as declaredFiles };` alias line, and
   nothing else (the function body itself no longer exists under that name).

5. `git status --porcelain plans/brief-58.md`
   Expected: no output — this plan changes no file outside the owned list, and
   `plans/brief-58.md` (the brief itself) is not one of the files this plan edits.
