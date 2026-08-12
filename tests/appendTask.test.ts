// appendTask.ts: the only script that appends a new task object to tasks.json, under the task-state lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { appendTask } from "../scripts/appendTask.ts";

const APPEND_TASK_URL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "appendTask.ts")).href;
const CLOSE_TASKS_URL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "closeTasks.ts")).href;
const SCRIPT = join(import.meta.dirname, "..", "scripts", "appendTask.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-appendTask-"));
  mkdirSync(join(root, ".taskTools"));
  writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 1, title: "first" }]));
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
  return root;
}

function tasksPath(root: string): string {
  return join(root, ".taskTools", "tasks.json");
}

function completedTasksPath(root: string): string {
  return join(root, ".taskTools", "completedTasks.json");
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(tasksPath(root), "utf8"));
}

function readCompleted(root: string): any[] {
  return JSON.parse(readFileSync(completedTasksPath(root), "utf8"));
}

test("assigns the next available number and appends the object as the last element", () => {
  const root = makeProjectRoot();
  const task = appendTask(root, { title: "second" });
  assert.equal(task.taskNumber, 2);
  assert.deepEqual(readTasks(root), [{ taskNumber: 1, title: "first" }, { taskNumber: 2, title: "second" }]);
});

test("the assigned number accounts for numbers already used in completedTasks.json", () => {
  const root = makeProjectRoot();
  writeFileSync(completedTasksPath(root), JSON.stringify([{ taskNumber: 5, title: "done" }]));
  const task = appendTask(root, { title: "second" });
  assert.equal(task.taskNumber, 6);
});

test("CLI reads the draft from stdin and prints the appended task including its assigned number", () => {
  const root = makeProjectRoot();
  const output = execFileSync("node", [SCRIPT], { cwd: root, input: JSON.stringify({ title: "second" }), encoding: "utf8" });
  const printed = JSON.parse(output);
  assert.equal(printed.taskNumber, 2);
  assert.equal(printed.title, "second");
  assert.equal(readTasks(root).length, 2);
});

test("CLI exits non-zero on empty stdin, leaving tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  assert.throws(() => execFileSync("node", [SCRIPT], { cwd: root, input: "", encoding: "utf8", stdio: "pipe" }));
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});

test("CLI exits non-zero on invalid JSON, leaving tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  assert.throws(() => execFileSync("node", [SCRIPT], { cwd: root, input: "not json", encoding: "utf8", stdio: "pipe" }));
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});

function requireExitZero(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) await sleep(5);
}

// Waits on startFile, then calls appendTask once.
function spawnAppendChild(sourceRoot: string, draft: Record<string, unknown>, startFile: string): ChildProcess {
  const code = `
import { existsSync } from "node:fs";
import { appendTask } from ${JSON.stringify(APPEND_TASK_URL)};
const WAIT = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
appendTask(${JSON.stringify(sourceRoot)}, ${JSON.stringify(draft)});
`;
  return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

// Waits on startFile, then calls closeTasks once.
function spawnCloseChild(sourceRoot: string, taskNumber: number, closureNote: string, startFile: string): ChildProcess {
  const code = `
import { existsSync } from "node:fs";
import { closeTasks } from ${JSON.stringify(CLOSE_TASKS_URL)};
const WAIT = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
closeTasks([${taskNumber}], ${JSON.stringify(closureNote)}, ${JSON.stringify(sourceRoot)});
`;
  return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

// Holds the real lock, writes ackFile, then blocks until releaseFile exists.
function spawnLockAcknowledgingChild(
  kind: "append" | "close",
  sourceRoot: string,
  arg: Record<string, unknown> | { taskNumber: number; note: string },
  startFile: string,
  ackFile: string,
  releaseFile: string,
): ChildProcess {
  const importLine = kind === "append"
    ? `import { appendTask } from ${JSON.stringify(APPEND_TASK_URL)};`
    : `import { closeTasks } from ${JSON.stringify(CLOSE_TASKS_URL)};`;
  const callLine = kind === "append"
    ? `appendTask(${JSON.stringify(sourceRoot)}, ${JSON.stringify(arg)}, { onAcquired });`
    : `closeTasks([${(arg as any).taskNumber}], ${JSON.stringify((arg as any).note)}, ${JSON.stringify(sourceRoot)}, [], { onAcquired });`;
  const code = `
import { existsSync, writeFileSync } from "node:fs";
${importLine}
const WAIT = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
function onAcquired() {
  writeFileSync(${JSON.stringify(ackFile)}, "ack");
  while (!existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(WAIT, 0, 0, 5);
}
${callLine}
`;
  return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

test("append wins the lock, close follows: the closed task archives cleanly and the appended task is not lost", async () => {
  const root = makeProjectRoot();
  const startFile = join(root, "start");
  const ackFile = join(root, "append-acquired");
  const releaseFile = join(root, "append-release");

  const append = spawnLockAcknowledgingChild("append", root, { title: "second" }, startFile, ackFile, releaseFile);
  writeFileSync(startFile, "go");
  await waitForFile(ackFile); // append provably holds the lock before closer is even started

  const close = spawnCloseChild(root, 1, "closed during race", startFile);
  writeFileSync(releaseFile, "go");
  await Promise.all([requireExitZero(append), requireExitZero(close)]);

  assert.deepEqual(readTasks(root), [{ taskNumber: 2, title: "second" }]);
  const completed = readCompleted(root);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].taskNumber, 1);
});

test("close wins the lock, append follows: task 1 stays closed and the appended task's number accounts for it", async () => {
  const root = makeProjectRoot();
  const startFile = join(root, "start");
  const ackFile = join(root, "close-acquired");
  const releaseFile = join(root, "close-release");

  const close = spawnLockAcknowledgingChild("close", root, { taskNumber: 1, note: "closed during race" }, startFile, ackFile, releaseFile);
  writeFileSync(startFile, "go");
  await waitForFile(ackFile); // close provably holds the lock before appender is even started

  const append = spawnAppendChild(root, { title: "second" }, startFile);
  writeFileSync(releaseFile, "go");
  await requireExitZero(close);
  await requireExitZero(append);

  assert.deepEqual(readTasks(root), [{ taskNumber: 2, title: "second" }]);
  const completed = readCompleted(root);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].taskNumber, 1);
});
