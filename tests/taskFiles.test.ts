// Behavioral checks for taskFiles.ts resolution + first-run seeding.
// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTaskFiles, seedTaskFilesIfAbsent } from "../scripts/taskFiles.ts";

function makeEmptyProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "taskTools-"));
}

test("test_resolvePrefersTaskToolsFolder", () => {
  // Scenario: a project has BOTH .taskTools/tasks.json and a root tasks.json.
  // Steps:
  // the project root contains a tasks.json.
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
  // Scenario: a pre-plugin project (like RevEng) keeps tasks.json at the root.
  // Steps:
  // only a root tasks.json exists — no .taskTools/ folder.
  const root = makeEmptyProjectRoot();
  writeFileSync(join(root, "tasks.json"), "[]\n");
  // resolving must return the root pair so existing repos keep working untouched.
  const pair = resolveTaskFiles(root);
  assert.equal(pair.tasksPath, join(root, "tasks.json"));
  assert.equal(pair.completedTasksPath, join(root, "completedTasks.json"));
});

test("test_resolveDefaultsToTaskToolsWhenNeitherExists", () => {
  // Scenario: a brand-new project with no task files anywhere.
  // Steps:
  // the project root is empty.
  const root = makeEmptyProjectRoot();
  // resolving must point at the .taskTools/ pair (where seeding will create them)...
  const pair = resolveTaskFiles(root);
  assert.equal(pair.tasksPath, join(root, ".taskTools", "tasks.json"));
  // ...and resolving alone must not create any file or folder (read-only skills must not write).
  assert.equal(existsSync(join(root, ".taskTools")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("test_resolveWalksUpToParentWithTaskFiles", () => {
  // Scenario: the shell cwd was left in a subdirectory (mid-session `cd`), but the
  // project's tasks.json lives at the root — resolution must walk up and find it.
  const root = makeEmptyProjectRoot();
  writeFileSync(join(root, "tasks.json"), "[]\n");
  const sub = join(root, "jfred", "src");
  mkdirSync(sub, { recursive: true });
  const pair = resolveTaskFiles(sub);
  assert.equal(pair.tasksPath, join(root, "tasks.json"));
});

test("test_seedCreatesBothFilesWithEmptyArrays", () => {
  // Scenario: first task creation in a fresh project generates both task files.
  // Steps:
  // the project root is empty; the resolved pair is the .taskTools/ default.
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
