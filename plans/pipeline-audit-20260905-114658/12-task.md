# Task 12 plan — ship the ignore-pattern fix to every seed path, not just brand-new projects

## Scope confirmation

- `scripts/taskFiles.ts`
  - Line 40, today: `const DEFAULT_IGNORE_PATTERNS = ["__pycache__/", "node_modules/", ".DS_Store", ".taskTools/runs/"];` — four entries, no `checkpoint.json` or `workflows/` pattern.
  - Lines 42–51, today:
    ```ts
    export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
      const taskFolder = dirname(pair.tasksPath);
      if (!existsSync(taskFolder)) seedGitignore(dirname(taskFolder));
      mkdirSync(taskFolder, { recursive: true });
      withTaskStateLock(pair.tasksPath, () => {
        for (const path of [pair.tasksPath, pair.completedTasksPath]) {
          if (!existsSync(path)) writeJsonAtomically(path, []);
        }
      });
    }
    ```
    `seedGitignore` only fires the first time `taskFolder` (normally `<projectRoot>/.taskTools`) does not yet exist. Every target project that already has `.taskTools/tasks.json` — which is every project this plugin has ever run in — never gets a new pattern added later, because `taskFolder` already exists on every later call.
  - Lines 18–23, today (unchanged by this task, reused by it):
    ```ts
    export function taskFilesProjectRoot(pair: TaskFilePair): string {
      const taskDirectory = dirname(pair.tasksPath)
      return basename(taskDirectory) === '.taskTools'
        ? dirname(taskDirectory)
        : taskDirectory
    }
    ```
    This already computes the correct project root for both the `.taskTools/tasks.json` layout and the legacy root `tasks.json` layout. `seedTaskFilesIfAbsent` does not call it today — it recomputes the wrong thing (`dirname(taskFolder)`, which is one directory too high whenever `pair` is the legacy root pair) inline instead.
  - Lines 54–61, today:
    ```ts
    function seedGitignore(projectRoot: string): void {
      const path = join(projectRoot, ".gitignore");
      const present = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
      const missing = DEFAULT_IGNORE_PATTERNS.filter((pattern) => !present.includes(pattern));
      if (missing.length === 0) return;
      const separator = present.length === 0 || present.at(-1) === "" ? "" : "\n";
      appendFileSync(path, `${separator}${missing.join("\n")}\n`);
    }
    ```
    Already idempotent (filters to only the patterns not already present, no-ops when nothing is missing). This function needs no change; only its call site needs to change.

- `tests/taskFiles.test.ts`
  - Lines 60–72, today, `test_seedCreatesBothFilesWithEmptyArrays`, asserts only the two JSON files' contents; it never reads `.gitignore`.
  - No existing test calls `seedTaskFilesIfAbsent` a second time against a project that already has `.taskTools/tasks.json` and checks `.gitignore` afterward — this is the exact gap task 12 closes.
  - Lines 74–114, today, `"concurrent first-run seeders leave both task files as valid JSON"`, spawns 16 processes that all call `seedTaskFilesIfAbsent(resolveTaskFiles(root))` against the same fresh `root` and asserts only the two JSON files' shape — it never reads `.gitignore`, so it does not currently catch a racing `seedGitignore`.

## Steps

### Step 1 — widen `DEFAULT_IGNORE_PATTERNS`

Test first, in `tests/taskFiles.test.ts`, appended after `test_seedCreatesBothFilesWithEmptyArrays` (after line 72):

```ts
test("test_seedTaskFilesIfAbsent_addsCheckpointAndWorkflowsPatternsToAFreshGitignore", () => {
    // Scenario: a brand-new project seeds its task files for the first time.
    // Step: the project root is empty.
    const root = makeEmptyProjectRoot();
    const pair = resolveTaskFiles(root);
    // Test action: seed the task files.
    seedTaskFilesIfAbsent(pair);
    // Verification: the checkpoint and per-task workflow patterns are both in .gitignore.
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /^\*\*\/plans\/checkpoint\.json$/m);
    assert.match(gitignore, /^\.taskTools\/workflows\/$/m);
});
```

This fails today: `.gitignore` gets `__pycache__/`, `node_modules/`, `.DS_Store`, `.taskTools/runs/` only.

Production change, `scripts/taskFiles.ts` line 40:

```ts
const DEFAULT_IGNORE_PATTERNS = ["__pycache__/", "node_modules/", ".DS_Store", ".taskTools/runs/", "**/plans/checkpoint.json", ".taskTools/workflows/"];
```

`**/plans/checkpoint.json` matches `checkpoint.ts:20`'s `join(worktree, "plans", "checkpoint.json")` under any worktree path. `.taskTools/workflows/` is the directory task 10 writes per-task `workflow.js`/`steps.json` pairs under; plan 10 depends on this pattern existing and does not add it itself.

### Step 2 — seed the gitignore on every seed call, not only first creation

Test first, in `tests/taskFiles.test.ts`, appended after the test from Step 1:

```ts
test("test_seedTaskFilesIfAbsent_addsMissingPatternsWhenTaskToolsAlreadyExists", () => {
    // Scenario: an established project already has .taskTools/tasks.json, from before these patterns existed.
    // Step: create .taskTools/tasks.json and completedTasks.json directly, with no .gitignore at all.
    const root = makeEmptyProjectRoot();
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 1, title: "t" }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
    const pair = resolveTaskFiles(root);
    // Test action: seed the task files again, the same call every skill invocation already makes.
    seedTaskFilesIfAbsent(pair);
    // Verification: the established project now has the ignore patterns, and its existing task did not move.
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /^\*\*\/plans\/checkpoint\.json$/m);
    assert.match(gitignore, /^\.taskTools\/workflows\/$/m);
    assert.equal(JSON.parse(readFileSync(pair.tasksPath, "utf8")).length, 1);
});
```

This fails today: `.taskTools` already exists, so `seedGitignore` never runs, and no `.gitignore` is created at all.

`seedGitignore`'s own read/filter/append is idempotent only against a serial caller. Two first-run seeders can both read `.gitignore` as absent, both compute the same "missing" list, and both append it, doubling every line — the existing 16-process concurrent-seeders test (`tests/taskFiles.test.ts` lines 74–114) already exercises exactly this shape of race for the JSON files, via `withTaskStateLock`; `seedGitignore` needs the same lock, not a bare unconditional call outside it.

Extend that test (`tests/taskFiles.test.ts` lines 74–114, `"concurrent first-run seeders leave both task files as valid JSON"`) with, right before its closing `finally`:

```ts
    const gitignoreLines = readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter((line) => line !== "");
    for (const pattern of ["__pycache__/", "node_modules/", ".DS_Store", ".taskTools/runs/", "**/plans/checkpoint.json", ".taskTools/workflows/"]) {
        assert.equal(gitignoreLines.filter((line) => line === pattern).length, 1);
    }
```

This fails until the production change below moves `seedGitignore` inside `withTaskStateLock`'s callback: with it left outside the lock, 16 processes race `seedGitignore`, so at least one pattern occurs more than once.

Production change, `scripts/taskFiles.ts` lines 42–50, replace:

```ts
export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  const taskFolder = dirname(pair.tasksPath);
  if (!existsSync(taskFolder)) seedGitignore(dirname(taskFolder));
  mkdirSync(taskFolder, { recursive: true });
  withTaskStateLock(pair.tasksPath, () => {
    for (const path of [pair.tasksPath, pair.completedTasksPath]) {
      if (!existsSync(path)) writeJsonAtomically(path, []);
    }
  });
}
```

with:

```ts
export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  const taskFolder = dirname(pair.tasksPath);
  mkdirSync(taskFolder, { recursive: true });
  withTaskStateLock(pair.tasksPath, () => {
    seedGitignore(taskFilesProjectRoot(pair));
    for (const path of [pair.tasksPath, pair.completedTasksPath]) {
      if (!existsSync(path)) writeJsonAtomically(path, []);
    }
  });
}
```

`taskFilesProjectRoot(pair)` (already defined at lines 18–23, already exported, already imported nowhere new — it lives in this same file) replaces the ad hoc `dirname(taskFolder)`, so a legacy root-pair project seeds its gitignore at the actual project root instead of one directory above it. `seedGitignore` moves inside the same `withTaskStateLock` critical section as the JSON-file seeding, so its read/filter/append runs serialized against every other seeder for this project, the same guarantee the JSON files already had. `seedGitignore` itself is already a no-op when every pattern is already present (line 58: `if (missing.length === 0) return;`), so calling it on every seed, now serialized, does not rewrite an already-correct `.gitignore`.

## Verification

```sh
npm test -- tests/taskFiles.test.ts
```
Expected: all tests in the file pass, including the two new ones and the extended concurrency race check.

```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```
Expected: `all passing`. If not, follow up with `npm test 2>&1 | tail -50` and fix, repeating until green.
