// closeTasks.ts moves closed tasks to completedTasks.json and skips already-completed or absent task numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTasks } from "../scripts/closeTasks.ts";

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 64, title: "first" },
      { taskNumber: 65, title: "second" },
      { taskNumber: 66, title: "third" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 60, title: "already done" }]));
  return root;
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

function readCompleted(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "completedTasks.json"), "utf8"));
}

test("closes one task, keeps sibling order, writes completionDate/commitHashes/closureNote", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks([65], "fixed by abc123", root);

  assert.deepEqual(closed, [65]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 66],
  );
  const completed = readCompleted(root).find((t) => t.taskNumber === 65);
  assert.equal(completed.closureNote, "fixed by abc123");
  assert.deepEqual(completed.commitHashes, []);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  assert.equal(
    completed.completionDate,
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  );
  assert.doesNotThrow(() => readTasks(root));
  assert.doesNotThrow(() => readCompleted(root));
});

test("duplicate task numbers close the task once and leave siblings alone", () => {
  const root = makeProjectRoot();
  const { closed } = closeTasks([65, 65], "fixed by abc123", root);

  assert.deepEqual(closed, [65]);
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 66],
  );
  assert.equal(readCompleted(root).filter((t) => t.taskNumber === 65).length, 1);
});

test("skips a task already in completedTasks.json and one absent from both files", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks([60, 99], "irrelevant", root);

  assert.deepEqual(closed, []);
  assert.deepEqual(skipped, [60, 99]);
  assert.equal(readCompleted(root).filter((t) => t.taskNumber === 60).length, 1);
});

test("records the given commit hashes on the closed task", () => {
  const root = makeProjectRoot();
  closeTasks([64], "shipped", root, ["abc123", "def456"]);
  const completed = readCompleted(root).find((t) => t.taskNumber === 64);
  assert.deepEqual(completed.commitHashes, ["abc123", "def456"]);
});

test("one call with per-task Record note/hashes gives each closed task its own values", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks(
    [64, 65],
    { 64: "fixed by abc123", 65: "verified by user" },
    root,
    { 64: ["abc123"], 65: [] },
  );

  assert.deepEqual(closed, [64, 65]);
  assert.deepEqual(skipped, []);
  const completed64 = readCompleted(root).find((t) => t.taskNumber === 64);
  const completed65 = readCompleted(root).find((t) => t.taskNumber === 65);
  assert.equal(completed64.closureNote, "fixed by abc123");
  assert.deepEqual(completed64.commitHashes, ["abc123"]);
  assert.equal(completed65.closureNote, "verified by user");
  assert.deepEqual(completed65.commitHashes, []);
});

test("a Record closureNote missing an entry for a closing task throws before writing either file", () => {
  const root = makeProjectRoot();
  assert.throws(() => closeTasks([64, 65], { 64: "fixed by abc123" }, root));
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 65, 66],
  );
  assert.equal(readCompleted(root).length, 1);
});

test("folds unblockDependents into the same write: closing a task clears it from dependents' blockedBy", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 64, title: "first" },
      { taskNumber: 65, title: "second", blockedBy: [{ taskNum: 64, reason: "needs task 64" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");

  const { closed, unblocked } = closeTasks([64], "fixed by abc123", root);

  assert.deepEqual(closed, [64]);
  assert.deepEqual(unblocked, [65]);
  const tasks = readTasks(root);
  assert.equal("blockedBy" in tasks.find((t) => t.taskNumber === 65), false);
});
