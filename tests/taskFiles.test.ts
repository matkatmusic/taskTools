// Behavioral checks for taskFiles.ts resolution + first-run seeding.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { leadingTaskNumbers, resolveTaskFiles, seedTaskFilesIfAbsent } from "../scripts/shared/taskFiles.ts";

function makeEmptyProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "taskTools-"));
}

test("test_resolvePrefersTaskToolsFolder", () => {
  // Scenario: a project has BOTH .taskTools/tasks.json and a root tasks.json.  Steps: the project root contains a tasks.json.
  const root = makeEmptyProjectRoot();
  writeFileSync(join(root, "tasks.json"), "[]\n");
  // the project also contains .taskTools/tasks.json.
  mkdirSync(join(root, ".taskTools"));
  writeFileSync(join(root, ".taskTools", "tasks.json"), "[]\n");
  // resolving must pick the .taskTools/ pair, not the root pair.
  const pair = resolveTaskFiles(root);
  assert.equal(pair.tasksPath, join(root, ".taskTools", "tasks.json"));
  assert.equal(pair.completedTasksPath, join(root, ".taskTools", "completedTasks.json"));
});

test("test_resolveFallsBackToRootTasksJson", () => {
  // Pre-plugin project: only a root tasks.json exists, no .taskTools/ folder.
  const root = makeEmptyProjectRoot();
  writeFileSync(join(root, "tasks.json"), "[]\n");
  // resolving must return the root pair so existing repos keep working untouched.
  const pair = resolveTaskFiles(root);
  assert.equal(pair.tasksPath, join(root, "tasks.json"));
  assert.equal(pair.completedTasksPath, join(root, "completedTasks.json"));
});

test("test_resolveDefaultsToTaskToolsWhenNeitherExists", () => {
  // Scenario: a brand-new project with no task files anywhere.  Steps: the project root is empty.
  const root = makeEmptyProjectRoot();
  // resolving must point at the .taskTools/ pair (where seeding will create them)...
  const pair = resolveTaskFiles(root);
  assert.equal(pair.tasksPath, join(root, ".taskTools", "tasks.json"));
  // ...and resolving alone must not create any file or folder (read-only skills must not write).
  assert.equal(existsSync(join(root, ".taskTools")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("test_resolveWalksUpToParentWithTaskFiles", () => {
  // Cwd is a subdirectory, but tasks.json lives at the root; resolution must walk up.
  const root = makeEmptyProjectRoot();
  writeFileSync(join(root, "tasks.json"), "[]\n");
  const sub = join(root, "jfred", "src");
  mkdirSync(sub, { recursive: true });
  const pair = resolveTaskFiles(sub);
  assert.equal(pair.tasksPath, join(root, "tasks.json"));
});

test("test_seedCreatesBothFilesWithEmptyArrays", () => {
  // Scenario: first task creation in a fresh project generates both task files.  Steps: the project root is empty; the resolved pair is the .taskTools/ default.
  const root = makeEmptyProjectRoot();
  const pair = resolveTaskFiles(root);
  // seeding creates both files, each holding an empty JSON array.
  seedTaskFilesIfAbsent(pair);
  assert.deepEqual(JSON.parse(readFileSync(pair.tasksPath, "utf8")), []);
  assert.deepEqual(JSON.parse(readFileSync(pair.completedTasksPath, "utf8")), []);
  // seeding again after a task exists must leave the existing content intact.
  writeFileSync(pair.tasksPath, JSON.stringify([{ taskNumber: 1, title: "t" }]) + "\n");
  seedTaskFilesIfAbsent(pair);
  assert.equal(JSON.parse(readFileSync(pair.tasksPath, "utf8")).length, 1);
});

test("concurrent first-run seeders leave both task files as valid JSON", async () => {
  const root = makeEmptyProjectRoot();
  const startFile = join(root, "start");
  const taskFilesModuleUrl = pathToFileURL(
    join(import.meta.dirname, "..", "scripts", "shared", "taskFiles.ts"),
  ).href;
  const childSource = `
    import { existsSync } from "node:fs";
    import { resolveTaskFiles, seedTaskFilesIfAbsent } from ${JSON.stringify(taskFilesModuleUrl)};
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(wait, 0, 0, 10);
    seedTaskFilesIfAbsent(resolveTaskFiles(${JSON.stringify(root)}));
  `;

  try {
    const children = Array.from({ length: 16 }, () =>
      spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
        cwd: root,
        stdio: "inherit",
      }),
    );
    const exits = children.map((child) => once(child, "exit"));
    writeFileSync(startFile, "go\n");

    for (const [code, signal] of await Promise.all(exits)) {
      assert.equal(signal, null);
      assert.equal(code, 0);
    }

    const pair = resolveTaskFiles(root);
    assert.deepEqual(JSON.parse(readFileSync(pair.tasksPath, "utf8")), []);
    assert.deepEqual(JSON.parse(readFileSync(pair.completedTasksPath, "utf8")), []);
    assert.equal(existsSync(join(root, ".taskTools", "task-state.lock")), false);
    assert.equal(
      readdirSync(join(root, ".taskTools")).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test_leadingTaskNumbersReadsTheArrayFromAWholeInvocationString", () => {
    // Setup: the whole argument string a skill passes through, array first, prose after.
    const invocation = "[346,347,348,349,350,351,353,345] valid";
    // Test action: parse the leading task numbers out of it.
    const numbers = leadingTaskNumbers([invocation]);
    // Verification: every number is recovered and the trailing word is ignored.
    assert.deepEqual(numbers, [346, 347, 348, 349, 350, 351, 353, 345]);
});

test("test_leadingTaskNumbersStopsAtFreeTextReasoning", () => {
    // Setup: a close-tasks style invocation with per-task reasoning after the array.
    const invocation = "[268,270] #268 fixed by X, #270 verified by user";
    // Test action: parse the leading task numbers out of it.
    const numbers = leadingTaskNumbers([invocation]);
    // Verification: only the array contributes, so numbers inside the prose are not picked up.
    assert.deepEqual(numbers, [268, 270]);
});

test("test_everyOpenTaskHasAGoalAndNotInScope", () => {
  const tasksPath = join(import.meta.dirname, "..", ".taskTools", "tasks.json");
  const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as Array<Record<string, unknown>>;
  for (const task of tasks) {
    const goal = task.goal;
    assert.ok(Array.isArray(goal) && goal.length > 0, `task ${task.taskNumber} has no goal`);
    assert.ok(goal.every((line) => typeof line === "string" && !line.includes("\n")), `task ${task.taskNumber} goal has an embedded newline`);
    assert.ok(Array.isArray(task.notInScope), `task ${task.taskNumber} has no notInScope`);
  }
});
