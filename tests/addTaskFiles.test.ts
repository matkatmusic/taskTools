// addTaskFiles.ts: appends repo-relative paths to a task's files array in .taskTools/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTaskFiles } from "../scripts/addTaskFiles.ts";
import { closeTasks } from "../scripts/closeTasks.ts";

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

test("two concurrent widen calls forced to interleave: the second call's write, injected mid-transaction, forces the first to retry so both widenings land", () => {
  const root = makeProjectRoot();
  let innerRan = false;
  addTaskFiles([1], ["from-a.ts"], root, () => {
    if (innerRan) return;
    innerRan = true;
    addTaskFiles([2], ["from-b.ts"], root);
  });
  const tasks = readTasks(root);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 1).files, ["existing.ts", "from-a.ts"]);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 2).files, ["from-b.ts"]);
});

test("a task closes mid-transaction while a different task is being widened: the widen retries onto fresh bytes and does not resurrect the closed task", () => {
  const root = makeProjectRoot();
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
  let closedInline = false;
  addTaskFiles([2], ["shared.ts"], root, () => {
    if (closedInline) return;
    closedInline = true;
    closeTasks([1], "closed during race", root);
  });
  const tasks = readTasks(root);
  assert.equal(tasks.some((t) => t.taskNumber === 1), false);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 2).files, ["shared.ts"]);
  const completed = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
  assert.equal(completed.some((t: any) => t.taskNumber === 1), true);
});

test("two concurrent widen calls forced to interleave inside the run-arguments write: neither widening's run-arguments entry is erased", () => {
  const root = makeProjectRoot();
  writeFileSync(
    join(root, ".taskTools", "run-arguments.json"),
    JSON.stringify({ groups: [{ tasks: [{ number: 1, files: [] }, { number: 2, files: [] }] }] }),
  );
  let innerRan = false;
  addTaskFiles([1], ["from-a.ts"], root, undefined, () => {
    if (innerRan) return;
    innerRan = true;
    addTaskFiles([2], ["from-b.ts"], root);
  });
  const snapshot = JSON.parse(readFileSync(join(root, ".taskTools", "run-arguments.json"), "utf8"));
  const allFiles = snapshot.groups.flatMap((g: any) => g.tasks).flatMap((t: any) => t.files);
  assert.ok(allFiles.includes("from-a.ts"));
  assert.ok(allFiles.includes("from-b.ts"));
});
