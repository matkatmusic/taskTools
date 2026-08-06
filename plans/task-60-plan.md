# Task 60 plan: split a task's raw user prompt into `userDescription`, separate from the agent-derived `description`

## Goal

Give a task record two distinct fields: `userDescription` holds the user's raw prompt verbatim (never edited,
summarized, or reworded), and `description` holds only the agent's derived, fleshed-out understanding (file
paths, line numbers, root-cause findings, constraints, decisions). Both existing readers of `description` must
surface `userDescription` under its own heading when present, without dropping it silently. `userDescription` is
optional — every task in `tasks.json`/`completedTasks.json` today predates it and has only `description`; no
migration of existing records.

## Edits

### 1. `skills/create-task/template/taskTemplate.json` — full-content edit

Current content (read in full):

```json
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
  "description": "<the task in the user's own wording, plus any refinements gathered; include file paths and repro URLs if given>",
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
}
```

Becomes (insert `userDescription` immediately after `title` and before `description`; rewrite the
`description` placeholder so it no longer describes itself as holding the user's wording):

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

The trailing blank line 10 of the file is unchanged.

### 2. `skills/create-task/SKILL.md` — insert one instruction paragraph

Current text at lines 17–21 (read in full):

```
```json
!`cat "${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json"`
```

Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.
```

Becomes (insert a new paragraph between the closing ```` ``` ```` of the template block and the existing
"Populate `files`" paragraph):

```
```json
!`cat "${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json"`
```

Populate `userDescription` with $ARGUMENTS verbatim, exactly as typed — never edit, summarize, or reword it. Populate `description` with only the agent's derived understanding gathered while writing the task: file paths, line numbers, root-cause findings, constraints, and decisions; it must not restate the raw prompt.

Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.
```

Nothing else in this file changes (lines 1–16 and 22–29 stay exactly as read).

### 3. `scripts/prepareTasks.ts` — `writeTaskBriefFile`, lines 182–188

Current text (read in full, matches lines 182–188 of the live file):

```
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        task.description ?? "",
        "",
        ...fileSections,
    ].join("\n");
```

Becomes (insert one line: when `task.userDescription` is present, splice in a "## User request" section
above the existing description content; when absent, behavior is byte-for-byte identical to today):

```
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        ...(task.userDescription ? [`## User request\n\n${task.userDescription}`, ""] : []),
        task.description ?? "",
        "",
        ...fileSections,
    ].join("\n");
```

Type-safety note: `TaskRecord` is read elsewhere in this same file (`getOpenBlockers`, line 108–111) via
`Array.isArray(task.blockedBy) ? task.blockedBy : []` followed by
`.filter((number): number is number => openNumbers.has(number as number))` — a type-predicate narrowing plus
`as number` cast that is only needed if `task.blockedBy` resolves to `unknown` (i.e. `TaskRecord` carries a
permissive index signature for fields beyond its explicitly declared ones, as `taskGroups.ts`'s
`Array.isArray(task.files) ? (task.files as string[]) : []` shows the same pattern for `task.files`). Reading
`task.userDescription` the same way — inside a truthy check and a template-literal interpolation, never assigned
to a `string`-typed variable — type-checks under that shape regardless of whether `userDescription` is one of
`TaskRecord`'s explicitly named optional fields or falls through its index signature, so no change to
`taskFiles.ts` (outside the owned-files list) is required.

No other lines in this file change.

### 4. `scripts/viewTaskHook.ts` — `formatTask`, lines 9–12

Current text (read in full, matches lines 9–12 of the live file):

```
function formatTask(task: TaskRecord, status: string): string {
  const lines = [`Task ${task.taskNumber} (${status}): ${task.title ?? ""}`];
  if (task.description) lines.push("", String(task.description));
  const extras = Object.entries(task).filter(([key]) => !["taskNumber", "title", "description"].includes(key));
```

Becomes (add a `userDescription` line under its own "User request:" label, ahead of the existing description
line, and exclude `userDescription` from the generic `extras` dump so it is never printed twice):

```
function formatTask(task: TaskRecord, status: string): string {
  const lines = [`Task ${task.taskNumber} (${status}): ${task.title ?? ""}`];
  if (task.userDescription) lines.push("", "User request:", String(task.userDescription));
  if (task.description) lines.push("", String(task.description));
  const extras = Object.entries(task).filter(([key]) => !["taskNumber", "title", "description", "userDescription"].includes(key));
```

No other lines in this file change (lines 1–8 and 13–52 stay exactly as read).

## Owned files that need no edit, and why

- `scripts/approvalGate.ts` — no reference to `description`/`userDescription`/`TaskRecord` anywhere in the file
  (deals only with `ApprovalDigestInput`, `RunState`, digests, and authorization tokens). Not implicated.
- `scripts/mergePipeline.ts` — no reference to `description`/`userDescription`/`TaskRecord`; consumes
  `WorkflowArguments`/`PreparedGroup`/`PreparedTask` (task `number`/`files` only) and manifest/consolidation
  types. Not implicated.
- `scripts/repositoryDiscovery.ts` — no reference to `description`/`userDescription`/`TaskRecord`; deals only
  with `RepositoryOccurrence` discovery. Not implicated.
- `scripts/taskGroups.ts` — reads only `task.taskNumber` and `task.files` (via `declaredFiles`) to group tasks
  by file overlap; never touches `description`. Not implicated.
- `skills/close-tasks/SKILL.md` — moves task objects into `completedTasks.json` and adds `completionDate`,
  `commitHashes`, `closureNote`; never reads, writes, or mentions `description` or `userDescription`. Not
  implicated.
- `skills/update-task-files/SKILL.md` — backfills only the `files` array ("Add a `files` array to each task
  shown above, inserted after `description`"); that instruction is unaffected by a new field existing between
  `title` and `description`, since it says nothing about field order beyond "after `description`", which still
  holds. Does not read or write `description`/`userDescription` content itself. Not implicated.
- `skills/tackle-tasks/implement.workflow.js` — builds worker briefs from `t.number`, `t.files`, `planFile`,
  `t.tests`; never references `t.description` or `t.userDescription`. Not implicated.
- `skills/tackle-tasks/plan.workflow.js` — builds planner briefs from `t.briefFile` (the file
  `writeTaskBriefFile` writes), `t.files`, `t.planFile`, `t.tests`, `t.number`; never reads `t.description` or
  `t.userDescription` directly — it relies on the brief file's rendered content, which change #3 already covers.
  Not implicated.
- `skills/tackle-tasks/test.workflow.js` — builds tester/fixer briefs from `t.files`, `t.number`, plan file
  path; never references `t.description` or `t.userDescription`. Not implicated.
- `skills/tackle-tasks/verify.workflow.js` — builds verifier briefs from `t.briefFile`, `t.files`, `planFile`,
  `t.number`; never references `t.description` or `t.userDescription` directly (same brief-file indirection as
  `plan.workflow.js`). Not implicated.
- `tests/prepareTasks.test.ts` — this task carries no `tests` field (or the literal string `skip`), so no new
  test is required. The existing tests construct tasks without `userDescription`
  (`{ taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] }` and similar) and assert on
  `task.description`'s content appearing in the brief; the code change in #3 makes the `userDescription` section
  purely additive and conditional on the field being present, so these tests keep passing unchanged. No edit.
- `tests/prepareTasksIntegration.test.ts` — exercises `bootstrapRepositoryManifest`, `getOwningOccurrence`, and
  `groupTasksByFileOverlap`/`buildWorkflowArguments` against a real git tree; none of its task fixtures or
  assertions touch `description` or `userDescription`. No edit.
- `tests/repositoryDiscovery.test.ts` — exercises `discoverRepositoryTree`/`setUpOperationBranches`/
  `getAncestorChain`; entirely about submodule occurrence graphs, no `TaskRecord` involved. No edit.
- `tests/taskGroups.test.ts` — exercises `groupTasksByFileOverlap` using `task(taskNumber, files?)` fixtures
  that never set `description` or `userDescription`; grouping logic in `taskGroups.ts` doesn't touch either
  field (per the no-edit reason above). No edit.

## Verification

Run from the repo root `/Users/matkatmusicllc/Programming/taskTools`:

1. Typecheck:
   ```
   npx tsc --noEmit
   ```
   Expected: no errors (this is the exact command named as `DEFAULT_TYPECHECK_COMMAND` in
   `scripts/prepareTasks.ts`).

2. Existing behavioral tests, unmodified, still pass:
   ```
   node --test tests/prepareTasks.test.ts tests/taskGroups.test.ts tests/repositoryDiscovery.test.ts tests/prepareTasksIntegration.test.ts
   ```
   Expected: all tests pass (this is the run command stated in each test file's own header comment, e.g.
   `tests/prepareTasks.test.ts`'s "Run with: node --test tests/").

3. Manual check that `writeTaskBriefFile` surfaces `userDescription` under its own heading and stays
   byte-identical for tasks without it — run from the repo root:
   ```
   bun -e '
   import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { execFileSync } from "node:child_process";
   import { writeTaskBriefFile } from "./scripts/prepareTasks.ts";
   const repoRoot = mkdtempSync(join(tmpdir(), "task60-check-"));
   execFileSync("git", ["-C", repoRoot, "init", "-q"]);
   writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
   execFileSync("git", ["-C", repoRoot, "add", "seed.txt"]);
   execFileSync("git", ["-C", repoRoot, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
   const withRaw = writeTaskBriefFile({ taskNumber: 1, title: "t1", userDescription: "fix the thing", description: "root cause: X at file.ts:10", files: [] }, repoRoot);
   const withoutRaw = writeTaskBriefFile({ taskNumber: 2, title: "t2", description: "legacy combined text", files: [] }, repoRoot);
   console.log("--- with userDescription ---");
   console.log(readFileSync(withRaw, "utf8"));
   console.log("--- without userDescription ---");
   console.log(readFileSync(withoutRaw, "utf8"));
   '
   ```
   Expected: the first brief contains a `## User request` section holding "fix the thing" followed by the
   `description` text "root cause: X at file.ts:10"; the second brief contains only "legacy combined text" with
   no `## User request` heading anywhere in it.

4. Manual check that `scripts/viewTaskHook.ts` surfaces `userDescription` under a "User request:" label and
   does not duplicate it in the generic extras dump — run from the repo root. This computes the real
   `tasksPath`/`completedTasksPath` via `resolveTaskFiles` itself rather than assuming a location, so the
   fixture always lands where the hook will actually look:
   ```
   TMPROOT=$(mktemp -d)
   git -C "$TMPROOT" init -q
   bun -e '
   import { resolveTaskFiles } from "./scripts/taskFiles.ts";
   console.log(JSON.stringify(resolveTaskFiles(process.argv[1])));
   ' "$TMPROOT" > "$TMPROOT/paths.json"
   TASKS_PATH=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tasksPath)' "$TMPROOT/paths.json")
   COMPLETED_PATH=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).completedTasksPath)' "$TMPROOT/paths.json")
   mkdir -p "$(dirname "$TASKS_PATH")"
   printf '[{"taskNumber":1,"title":"t1","userDescription":"fix the thing","description":"root cause: X"}]' > "$TASKS_PATH"
   printf '[]' > "$COMPLETED_PATH"
   printf '{"prompt":"/view-task 1","cwd":"%s"}' "$TMPROOT" | bun scripts/viewTaskHook.ts
   ```
   Expected: the JSON `reason` string contains a `User request:` line followed by "fix the thing", then the
   existing description line "root cause: X", and no `userDescription: fix the thing` line appears in the
   generic `key: value` extras section below it.
