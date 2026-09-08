# Plan: task 62 — fold handoffFilePaths into readFilePaths

## Behavior in plain English

A task record can carry `handoffFilePaths`: repo-relative paths to the notes the task came from. `appendTask.ts` writes the field. Nothing reads it. So the planner and the implementer never see those notes.

After this change `loadPreparedTask` reads `handoffFilePaths`. Each path must exist in the worktree, the same rule `readOnlyFiles` has. Each path joins `readFilePaths` after the read-only files and before the owned files. Every `/read-file` line in every prompt already comes from `readFilePaths`, so no prompt emitter changes.

## Files this plan touches

| File | Change |
|---|---|
| `tests/prepareTasks.test.ts` | two new tests |
| `scripts/tackle-tasks/shared/preparedTask.ts` | read the field, check it, add it to `readFilePaths` |

Do not touch `appendTask.ts`, `prepareTasks.ts`, or any prompt emitter. Do not add a `handoffFilePaths` field to the `PreparedTask` type.

## Step 1 — RED: two tests in tests/prepareTasks.test.ts

Place both directly after `test_loadPreparedTaskThrowsWhenAReadOnlyFileIsMissingOnDisk`. They mirror that test's setup line for line. `makeTempRepoWithCommit`, `writeTaskBriefFile`, and `loadPreparedTask` are already imported there.

```ts
test("test_loadPreparedTaskAddsHandoffFilePathsToReadFilePathsAfterReadOnlyFiles", () => {
    // Setup: a task with one readOnlyFiles entry, one handoffFilePaths entry, and one owned file, all on disk.
    const repoRoot = makeTempRepoWithCommit();
    const taskDirectory = join(repoRoot, ".taskTools");
    mkdirSync(taskDirectory, { recursive: true });
    writeFileSync(join(repoRoot, "a.ts"), "a\n");
    writeFileSync(join(repoRoot, "b.ts"), "b\n");
    mkdirSync(join(repoRoot, "plans", "archived"), { recursive: true });
    writeFileSync(join(repoRoot, "plans", "archived", "note.md"), "note\n");
    const task = { taskNumber: 1, title: "t1", description: "desc", modifiableFiles: ["a.ts"], readOnlyFiles: ["b.ts"], handoffFilePaths: ["plans/archived/note.md"] };
    writeFileSync(join(taskDirectory, "tasks.json"), JSON.stringify([task]));
    writeFileSync(join(taskDirectory, "completedTasks.json"), "[]\n");
    writeTaskBriefFile(task, repoRoot);
    // Action: build the prepared task.
    const prepared = loadPreparedTask(1, repoRoot, repoRoot);
    // Verification: read-only first, handoff second, owned last; every path is absolute.
    assert.deepEqual(prepared.readFilePaths, [
        `${repoRoot}/b.ts`,
        `${repoRoot}/plans/archived/note.md`,
        `${repoRoot}/a.ts`,
    ]);
});

test("test_loadPreparedTaskThrowsWhenAHandoffFileIsMissingOnDisk", () => {
    // Setup: a task naming a handoffFilePaths entry that does not exist in the worktree.
    const repoRoot = makeTempRepoWithCommit();
    const taskDirectory = join(repoRoot, ".taskTools");
    mkdirSync(taskDirectory, { recursive: true });
    const task = { taskNumber: 1, title: "t1", description: "desc", modifiableFiles: ["a.ts"], createsFiles: ["a.ts"], handoffFilePaths: ["plans/archived/gone.md"] };
    writeFileSync(join(taskDirectory, "tasks.json"), JSON.stringify([task]));
    writeFileSync(join(taskDirectory, "completedTasks.json"), "[]\n");
    writeTaskBriefFile(task, repoRoot);
    // Verification: the stale handoff path stops the run instead of silently pointing at nothing.
    assert.throws(
        () => loadPreparedTask(1, repoRoot, repoRoot),
        /task 1: handoffFilePaths names .*gone\.md but the file does not exist/,
    );
});
```

Run only this file:

```
node --test tests/prepareTasks.test.ts
```

The first new test fails: `readFilePaths` has two entries, not three. The second fails: nothing throws.

## Step 2 — GREEN: preparedTask.ts

In `loadPreparedTask`, directly after the `readOnlyFilePaths` loop (the `for` that ends at line 73), add:

```ts
    const handoffFilePaths: string[] = Array.isArray((task as any).handoffFilePaths) ? (task as any).handoffFilePaths : [];
    const handoffPaths = handoffFilePaths.map((file) => `${root}/${file}`);
    for (const path of handoffPaths) {
        if (!existsSync(path)) throw new Error(`task ${taskNumber}: handoffFilePaths names ${path} but the file does not exist`);
    }
```

Then change the `readFilePaths` line (line 102) to:

```ts
        readFilePaths: [...readOnlyFilePaths, ...handoffPaths, ...files.map((file) => `${root}/${file}`).filter((path) => existsSync(path))],
```

Then update the comment on line 27 to:

```ts
    // Every /read-file line: readOnlyFiles' absolute paths, then handoffFilePaths, then the owned files that exist on disk.
```

Why the same `Array.isArray((task as any).x)` shape as `createsFiles` on line 74: `TaskRecord` is an open record, and this file already reads optional fields that way. Why a hard throw and not a filter: a handoff path is written by a person or by `update-tasks`; a wrong path is a bug in the task record, and `readOnlyFiles` on line 72 already throws for the same reason.

Run the same single test file again. Every test in it must pass.

## Step 3 — hand the suite to one subagent

One subagent runs `npm run test:baseline` from the repo root and reports new failures only. Do not run it yourself. Prompt-shape tests that snapshot `readFilePaths` (`scripts/tackle-tasks/shared/promptSections.test.ts`, `scripts/tackle-tasks/shared/dumpPromptShapes.ts` fixtures) use tasks without `handoffFilePaths`, so they should be unchanged. If one fails, report it; do not edit it.

## Report shape

Files changed, test counts per file run, notes. No diff.
