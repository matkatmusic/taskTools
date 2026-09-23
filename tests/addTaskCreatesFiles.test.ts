// addTaskCreatesFiles.ts: appends repo-relative paths to a task's createsFiles in .taskTools/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTaskCreatesFiles } from "../scripts/shared/addTaskCreatesFiles.ts";

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-addTaskCreatesFiles-"));
  mkdirSync(join(root, ".taskTools"));
  writeFileSync(
    join(root, ".taskTools", "tasks.json"),
    JSON.stringify(
      [
        { taskNumber: 1, title: "first", modifiableFiles: ["existing.ts"] },
        { taskNumber: 2, title: "second", modifiableFiles: [] },
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

function readTask(root: string, taskNumber: number): any {
  return JSON.parse(readFileSync(tasksPath(root), "utf8")).find((task: any) => task.taskNumber === taskNumber);
}

test("appends a missing path to createsFiles while the path stays in modifiableFiles", () => {
  const root = makeProjectRoot();
  addTaskCreatesFiles([1], ["new.ts"], root);
  const task = readTask(root, 1);
  assert.deepEqual(task.modifiableFiles, ["existing.ts"]);
  assert.deepEqual(task.createsFiles, ["new.ts"]);
});

test("the same incoming path repeated on one call is appended to createsFiles only once", () => {
  const root = makeProjectRoot();
  addTaskCreatesFiles([2], ["a.ts", "b.ts", "a.ts"], root);
  assert.deepEqual(readTask(root, 2).createsFiles, ["a.ts", "b.ts"]);
});

test("an unknown task number throws and leaves tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  assert.throws(() => addTaskCreatesFiles([999], ["whatever.ts"], root), /not found in tasks\.json: 999/);
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});

test("absolute paths and directory traversal are rejected", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  for (const bad of ["/etc/passwd", "../outside.ts", ".", "..", ""]) {
    assert.throws(() => addTaskCreatesFiles([1], [bad], root), /addTaskCreatesFiles: rejected/, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});
