// addTaskFiles.ts: appends repo-relative paths to a task's files array in .taskTools/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ADD_TASK_FILES_URL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "shared", "addTaskFiles.ts")).href;
const CLOSE_TASKS_URL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "close-tasks", "closeTasks.ts")).href;

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

// Waits on startFile, optionally sleeps delayMs to bias lock-acquisition order, then calls addTaskFiles once.
function spawnWidenChild(sourceRoot: string, taskNumber: number, path: string, startFile: string, delayMs = 0): ChildProcess {
  const code = `
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { addTaskFiles } from ${JSON.stringify(ADD_TASK_FILES_URL)};
const WAIT = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
await setTimeout(${delayMs});
addTaskFiles([${taskNumber}], [${JSON.stringify(path)}], ${JSON.stringify(sourceRoot)});
`;
  return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

// Waits on startFile, optionally sleeps delayMs, then calls closeTasks once.
function spawnCloseChild(sourceRoot: string, taskNumber: number, closureNote: string, startFile: string, delayMs = 0): ChildProcess {
  const code = `
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { closeTasks } from ${JSON.stringify(CLOSE_TASKS_URL)};
const WAIT = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
await setTimeout(${delayMs});
closeTasks([${taskNumber}], ${JSON.stringify(closureNote)}, ${JSON.stringify(sourceRoot)});
`;
  return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) await sleep(5);
}

// Holds the real lock, writes ackFile, then blocks until releaseFile exists.
function spawnLockAcknowledgingChild(
  kind: "widen" | "close",
  sourceRoot: string,
  taskNumber: number,
  arg: string,
  startFile: string,
  ackFile: string,
  releaseFile: string,
): ChildProcess {
  const importLine = kind === "widen"
    ? `import { addTaskFiles } from ${JSON.stringify(ADD_TASK_FILES_URL)};`
    : `import { closeTasks } from ${JSON.stringify(CLOSE_TASKS_URL)};`;
  const callLine = kind === "widen"
    ? `addTaskFiles([${taskNumber}], [${JSON.stringify(arg)}], ${JSON.stringify(sourceRoot)}, { onAcquired });`
    : `closeTasks([${taskNumber}], ${JSON.stringify(arg)}, ${JSON.stringify(sourceRoot)}, [], { onAcquired });`;
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

const SCRIPT = join(import.meta.dirname, "..", "scripts", "shared", "addTaskFiles.ts");

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

test("concurrent CLI wideners preserve the full union in both authoritative files", async () => {
  const root = makeProjectRoot();
  writeFileSync(
    join(root, ".taskTools", "run-arguments.json"),
    JSON.stringify({ groups: [{ tasks: [{ number: 1, files: ["existing.ts"] }] }] }),
  );
  const startFile = join(root, "start");
  const paths = Array.from({ length: 16 }, (_, index) => `from-${index}.ts`);

  const children = paths.map((path) => spawnWidenChild(root, 1, path, startFile));
  writeFileSync(startFile, "go");
  await Promise.all(children.map(requireExitZero));

  const task = readTasks(root).find((t) => t.taskNumber === 1);
  assert.deepEqual(new Set(task.files), new Set(["existing.ts", ...paths]));
  const snapshot = JSON.parse(readFileSync(join(root, ".taskTools", "run-arguments.json"), "utf8"));
  assert.deepEqual(new Set(snapshot.groups[0].tasks[0].files), new Set(["existing.ts", ...paths]));
});

test("root and nested-cwd writers use the same authoritative lock", async () => {
  const root = makeProjectRoot();
  const nested = join(root, "packages", "child");
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(root, ".taskTools", "run-arguments.json"),
    JSON.stringify({ groups: [{ tasks: [{ number: 1, files: ["existing.ts"] }] }] }),
  );
  const startFile = join(root, "start");
  const rootPaths = Array.from({ length: 8 }, (_, index) => `root-${index}.ts`);
  const nestedPaths = Array.from({ length: 8 }, (_, index) => `nested-${index}.ts`);

  const children = [
    ...rootPaths.map((path) => spawnWidenChild(root, 1, path, startFile)),
    ...nestedPaths.map((path) => spawnWidenChild(nested, 1, path, startFile)),
  ];
  writeFileSync(startFile, "go");
  await Promise.all(children.map(requireExitZero));

  const task = readTasks(root).find((t) => t.taskNumber === 1);
  assert.deepEqual(new Set(task.files), new Set(["existing.ts", ...rootPaths, ...nestedPaths]));
  const snapshot = JSON.parse(readFileSync(join(root, ".taskTools", "run-arguments.json"), "utf8"));
  assert.deepEqual(new Set(snapshot.groups[0].tasks[0].files), new Set(["existing.ts", ...rootPaths, ...nestedPaths]));
  assert.equal(existsSync(join(nested, ".taskTools", "task-state.lock")), false);
});

test("widener wins the lock, closer follows: the archived task carries the widened file and the run snapshot has it too", async () => {
  const root = makeProjectRoot();
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
  writeFileSync(
    join(root, ".taskTools", "run-arguments.json"),
    JSON.stringify({ groups: [{ tasks: [{ number: 1, files: ["existing.ts"] }] }] }),
  );
  const startFile = join(root, "start");
  const ackFile = join(root, "widen-acquired");
  const releaseFile = join(root, "widen-release");

  const widen = spawnLockAcknowledgingChild("widen", root, 1, "b.ts", startFile, ackFile, releaseFile);
  writeFileSync(startFile, "go");
  await waitForFile(ackFile); // widen provably holds the lock before closer is even started

  const close = spawnCloseChild(root, 1, "closed during race", startFile);
  writeFileSync(releaseFile, "go");
  await Promise.all([requireExitZero(widen), requireExitZero(close)]);

  assert.equal(readTasks(root).some((t) => t.taskNumber === 1), false);
  const completed = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
  const archived = completed.find((t: any) => t.taskNumber === 1);
  assert.deepEqual(archived.files, ["existing.ts", "b.ts"]);
  const snapshot = JSON.parse(readFileSync(join(root, ".taskTools", "run-arguments.json"), "utf8"));
  assert.deepEqual(snapshot.groups[0].tasks[0].files, ["existing.ts", "b.ts"]);
});

test("closer wins the lock, widener follows: the widener exits non-zero and the task is not resurrected", async () => {
  const root = makeProjectRoot();
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
  const startFile = join(root, "start");
  const ackFile = join(root, "close-acquired");
  const releaseFile = join(root, "close-release");

  const close = spawnLockAcknowledgingChild("close", root, 1, "closed during race", startFile, ackFile, releaseFile);
  writeFileSync(startFile, "go");
  await waitForFile(ackFile); // close provably holds the lock before widener is even started

  const widen = spawnWidenChild(root, 1, "b.ts", startFile);
  writeFileSync(releaseFile, "go");
  await requireExitZero(close);
  await assert.rejects(requireExitZero(widen), /exited [^0]/);

  assert.equal(readTasks(root).some((t) => t.taskNumber === 1), false);
  const completed = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
  assert.equal(completed.filter((t: any) => t.taskNumber === 1).length, 1);
});
