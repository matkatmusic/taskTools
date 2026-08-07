// addTaskFiles.ts: appends repo-relative paths to a task's files array in .taskTools/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "addTaskFiles.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-addTaskFiles-"));
  mkdirSync(join(root, ".taskTools"));
  writeFileSync(
    join(root, ".taskTools", "tasks.json"),
    JSON.stringify(
      [
        { taskNumber: 1, title: "first", files: ["existing.ts"] },
        { taskNumber: 2, title: "second", files: [] },
      ],
      null,
      2,
    ) + "\n",
  );
  return root;
}

function tasksPath(root: string): string {
  return join(root, ".taskTools", "tasks.json");
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(tasksPath(root), "utf8"));
}

function run(root: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd: root, encoding: "utf8" });
}

function runExpectingFailure(root: string, ...args: string[]): string {
  try {
    run(root, ...args);
  } catch (error) {
    return String((error as { stderr: string }).stderr);
  }
  assert.fail("expected addTaskFiles.ts to exit non-zero");
}

test("appends new paths in order, deduping against what the task already owns", () => {
  const root = makeProjectRoot();
  run(root, "[1]", "existing.ts", "new.ts");
  const task = readTasks(root).find((t) => t.taskNumber === 1);
  assert.deepEqual(task.files, ["existing.ts", "new.ts"]);
});

test("the same incoming path repeated on one call is appended only once", () => {
  const root = makeProjectRoot();
  run(root, "[2]", "a.ts", "b.ts", "a.ts");
  const task = readTasks(root).find((t) => t.taskNumber === 2);
  assert.deepEqual(task.files, ["a.ts", "b.ts"]);
});

test("a multi-task-number call appends the same paths to every named task", () => {
  const root = makeProjectRoot();
  run(root, "[1,2]", "shared.ts");
  const tasks = readTasks(root);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 1).files, ["existing.ts", "shared.ts"]);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 2).files, ["shared.ts"]);
});

test("an unknown task number exits non-zero and leaves tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  const stderr = runExpectingFailure(root, "[999]", "whatever.ts");
  assert.match(stderr, /not found in tasks\.json: 999/);
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});

test("absolute paths and directory traversal are rejected, leaving tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  for (const bad of ["/etc/passwd", "../outside.ts", "a/../../outside.ts", ".", "..", ""]) {
    const stderr = runExpectingFailure(root, "[1]", bad);
    assert.match(stderr, /addTaskFiles: rejected/, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});
