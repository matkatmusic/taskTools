# Task 162 plan: addTaskFiles.ts refreshes run-arguments.json's files snapshot

## Scope confirmation

`resolveRunArgumentsPath` is already exported in `scripts/prepareTasks.ts` (current line 77: `export function resolveRunArgumentsPath(repoRoot: string): string {`). No edit to `scripts/prepareTasks.ts` is needed — it already exports the helper the brief says to reuse, and the brief forbids touching `scripts/mergePipeline.ts`, so `scripts/prepareTasks.ts` has zero required edits for this task.

`tests/prepareTasks.test.ts` has zero required edits: no behavior in `prepareTasks.ts` changes, so nothing there needs new coverage.

All required edits are in `scripts/addTaskFiles.ts` (behavior) and `tests/addTaskFiles.test.ts` (coverage).

## Edit 1 — scripts/addTaskFiles.ts, lines 1-4 (imports)

Current text:
```
// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { writeFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
```

New text:
```
// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { resolveRunArgumentsPath } from "./prepareTasks.ts";
```

Reasoning: need `existsSync`/`readFileSync` to read the optional snapshot, and `resolveRunArgumentsPath` per the brief's instruction to reuse it rather than re-deriving the path. No circular import: `scripts/prepareTasks.ts` does not import `scripts/addTaskFiles.ts`, and `prepareTasks.ts`'s bottom-of-file `if (process.argv[1] && import.meta.url === ...) runAsCli();` guard compares `prepareTasks.ts`'s own `import.meta.url` to `process.argv[1]`; when `addTaskFiles.ts` is the entry script that comparison is false, so importing `resolveRunArgumentsPath` triggers no side effect.

## Edit 2 — scripts/addTaskFiles.ts, insert after line 36 (`}`, end of `appendFiles`), before line 38 (`function runAsCli(): void {`)

Current text (lines 36-38):
```
}

function runAsCli(): void {
```

New text:
```
}

type RunArgumentsSnapshot = { groups: { tasks: { number: number; files: string[] }[] }[] } & Record<string, unknown>;

function refreshRunArgumentsSnapshot(repoRoot: string, tasks: TaskRecord[]): void {
    const argumentsPath = resolveRunArgumentsPath(repoRoot);
    if (!existsSync(argumentsPath)) return;
    const snapshot = JSON.parse(readFileSync(argumentsPath, "utf8")) as RunArgumentsSnapshot;
    const filesByNumber = new Map(tasks.map((task) => [task.taskNumber, (task[FILES_KEY] as string[] | undefined) ?? []]));
    for (const group of snapshot.groups) {
        for (const task of group.tasks) {
            if (filesByNumber.has(task.number)) task.files = filesByNumber.get(task.number)!;
        }
    }
    writeFileSync(argumentsPath, JSON.stringify(snapshot));
}

function runAsCli(): void {
```

Reasoning:
- `RunArgumentsSnapshot` types only the two fields this function reads/writes (`groups[].tasks[].number` and `.files`); every other field (`runId`, `mergeScript`, `repositoryManifest`, `repositorySources`, `repo`, `typecheckCommand`, `startTimestamp`) passes through untouched via `& Record<string, unknown>` and is never assigned to, so no other field of the snapshot is rewound or altered.
- `.taskTools/run-arguments.json` shape comes from `scripts/prepareTasks.ts`'s `buildWorkflowArguments` (`PreparedGroup.tasks: PreparedTask[]`, each `PreparedTask` carrying `number` and `files`): `groups[].tasks[].files`, keyed by `.number`, matches exactly.
- Matching is by `task.taskNumber` (tasks.json's key) against `task.number` (the snapshot's key) — these are different field names for the same task identity, confirmed from `PreparedTask.number = task.taskNumber` in `buildWorkflowArguments` (prepareTasks.ts line 175).
- If the snapshot's task number isn't present in the freshly read `tasks.json` (e.g., a task already archived out of `tasks.json`), `filesByNumber.has(...)` is false and that group's task is left alone — no crash, no incorrect overwrite.
- `writeFileSync(argumentsPath, JSON.stringify(snapshot))` uses no pretty-printing, matching the existing writer's format at `prepareTasks.ts` line 232 (`writeFileSync(argumentsFile, JSON.stringify(pipelineArguments));`).
- When the file is absent, `existsSync` returns false and the function returns immediately, changing nothing and creating nothing — satisfies the brief's "when there is no snapshot" requirement.

## Edit 3 — scripts/addTaskFiles.ts, lines 56-60 (end of `runAsCli`)

Current text:
```
    for (const task of tasks) {
        if (numbers.includes(task.taskNumber)) appendFiles(task, paths);
    }
    writeFileSync(pair.tasksPath, JSON.stringify(tasks, null, 2) + "\n");
}
```

New text:
```
    for (const task of tasks) {
        if (numbers.includes(task.taskNumber)) appendFiles(task, paths);
    }
    writeFileSync(pair.tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    refreshRunArgumentsSnapshot(repoRoot, tasks);
}
```

Reasoning: `repoRoot` is already in scope (`const repoRoot = process.cwd();` at line 39 of the current file). `tasks` at this point is the full array read from `tasks.json`, already mutated in place by `appendFiles` for every requested task number — passing it gives `refreshRunArgumentsSnapshot` the exact same `files` values that were just written to `tasks.json`, satisfying "every task's `files` array there matches tasks.json." The call sits after the `tasks.json` write and before the two early-exit `process.exit(1)` paths above it in the function (the "not found" and "rejected path" checks both return before this point), so the snapshot refresh only runs on a run that actually mutated `tasks.json`.

## Edit 4 — tests/addTaskFiles.test.ts, line 5 (imports)

Current text:
```
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
```

New text:
```
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
```

Reasoning: the new "absent snapshot" test below needs `existsSync` to assert nothing was created.

## Edit 5 — tests/addTaskFiles.test.ts, append after line 87 (end of file, after the last test's closing `});`)

Current text (last lines of file):
```
test("absolute paths and directory traversal are rejected, leaving tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  for (const bad of ["/etc/passwd", "../outside.ts", "a/../../outside.ts", ".", "..", ""]) {
    const stderr = runExpectingFailure(root, "[1]", bad);
    assert.match(stderr, /addTaskFiles: rejected/, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});
```

Append this text after that block (new content, nothing removed):
```

test("refreshes each task's files array in .taskTools/run-arguments.json to match tasks.json", () => {
  const root = makeProjectRoot();
  const snapshotPath = join(root, ".taskTools", "run-arguments.json");
  const snapshot = {
    runId: "unchanged-run-id",
    groups: [
      { groupId: 1, worktree: "/tmp/wt1", branch: "task-1", scope: "declared", tasks: [{ number: 1, briefFile: "brief1.md", planFile: "plan1.md", files: ["existing.ts"] }] },
      { groupId: 2, worktree: "/tmp/wt2", branch: "task-2", scope: "declared", tasks: [{ number: 2, briefFile: "brief2.md", planFile: "plan2.md", files: [] }] },
    ],
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  run(root, "[1]", "existing.ts", "new.ts");
  const refreshed = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(refreshed.groups[0].tasks[0].files, ["existing.ts", "new.ts"]);
  assert.deepEqual(refreshed.groups[1].tasks[0].files, []);
  assert.equal(refreshed.runId, "unchanged-run-id");
  assert.equal(refreshed.groups[0].worktree, "/tmp/wt1");
});

test("when .taskTools/run-arguments.json is absent, addTaskFiles.ts succeeds and creates nothing", () => {
  const root = makeProjectRoot();
  run(root, "[1]", "new.ts");
  assert.equal(existsSync(join(root, ".taskTools", "run-arguments.json")), false);
});
```

Reasoning:
- Test 1 sets up a snapshot shaped exactly like `buildWorkflowArguments`'s output (`groups[].tasks[].number`/`.files`, plus a `runId` and a `worktree` field standing in for the fields the fix must leave untouched), runs `addTaskFiles.ts` against task 1 (which `makeProjectRoot` seeds with `files: ["existing.ts"]`, matching the snapshot's task 1 `files`), and checks: task 1's snapshot files become `["existing.ts", "new.ts"]` (matching what `appendFiles` produces in `tasks.json`), task 2's snapshot files stay `[]` (untouched request, still equal to its unchanged `tasks.json` value), and `runId`/`worktree` are byte-identical to what was written — proving only `files` arrays move.
- Test 2 uses the existing `makeProjectRoot` (which never creates `.taskTools/run-arguments.json`) and asserts the file still doesn't exist after a normal run — proving the fix doesn't create the snapshot when none exists, matching the brief's "does not exist... succeed and change nothing... do not create it."

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
npm test -- tests/addTaskFiles.test.ts tests/prepareTasks.test.ts
```

Expected: all tests in both files pass, including the two new tests in `tests/addTaskFiles.test.ts` (0 failures reported by `node --test`).

Then run the full suite to confirm no other file regressed:

```
npm test
```

Expected: `node --test "tests/**/*.test.ts"` reports 0 failures.
