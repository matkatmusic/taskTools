// checkBlockers.ts: a task is BLOCKED only by still-open blockers; closed ones don't count. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "checkBlockers.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "open blocker" },
      { taskNumber: 2, title: "blocked by open task", blockedBy: [{ taskNumber: 1, reason: "needs task 1" }] },
      { taskNumber: 4, title: "blocked only by closed task", blockedBy: [{ taskNumber: 3, reason: "needs task 3" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "closed blocker" }]));
  return root;
}

function makeCycleProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-cycle-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "cycle a", blockedBy: [{ taskNumber: 2, reason: "needs task 2" }] },
      { taskNumber: 2, title: "cycle b", blockedBy: [{ taskNumber: 3, reason: "needs task 3" }] },
      { taskNumber: 3, title: "cycle c", blockedBy: [{ taskNumber: 1, reason: "needs task 1" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
  return root;
}

function makeSelfBlockProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-selfblock-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 1, title: "self blocker", blockedBy: [{ taskNumber: 1, reason: "needs itself" }] }]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
  return root;
}

function makeIgnoredBlockersProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-ignored-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "blocked only by closed task", blockedBy: [{ taskNumber: 2, reason: "needs task 2" }] },
      { taskNumber: 3, title: "blocked only by nonexistent task", blockedBy: [{ taskNumber: 99, reason: "needs task 99" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 2, title: "closed blocker" }]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function runScriptExpectingFailure(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
  throw new Error("expected checkBlockers to exit non-zero");
}

test("flags open blockers, ignores closed ones, passes unblocked tasks", () => {
  const out = runScript(makeProjectRoot(), "2", "4", "1");
  assert.match(out, /task 2: BLOCKED by open task\(s\) \[\{"taskNumber":1,"reason":"needs task 1"\}\]/);
  assert.match(out, /task 4: unblocked/);
  assert.match(out, /task 1: unblocked/);
});

test("--unblocked prints only unblocked numbers, space-separated", () => {
  const out = runScript(makeProjectRoot(), "--unblocked", "2", "4", "1");
  assert.equal(out, "4 1\n");
});

test("no task numbers checks every open task", () => {
  const out = runScript(makeProjectRoot());
  assert.match(out, /task 1: unblocked/);
  assert.match(out, /task 2: BLOCKED by open task\(s\) \[\{"taskNumber":1,"reason":"needs task 1"\}\]/);
  assert.match(out, /task 4: unblocked/);
});

test("non-numeric args like 'valid' are ignored", () => {
  const out = runScript(makeProjectRoot(), "2", "valid");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNumber":1,"reason":"needs task 1"}]\n');
});

test("digits after prose are not task numbers, even as one quoted string", () => {
  const out = runScript(makeProjectRoot(), "2 valid see task 4 from 2026-07-21");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNumber":1,"reason":"needs task 1"}]\n');
});

test("detects a three-task cycle among open tasks and exits non-zero", () => {
  const { status, stderr } = runScriptExpectingFailure(makeCycleProjectRoot());
  assert.notEqual(status, 0);
  assert.match(stderr, /cycle detected among open tasks: 1, 2, 3/);
});

test("detects a self-blocking task as a one-task cycle", () => {
  const { status, stderr } = runScriptExpectingFailure(makeSelfBlockProjectRoot());
  assert.notEqual(status, 0);
  assert.match(stderr, /cycle detected among open tasks: 1/);
});

test("ignores blockedBy entries pointing at completed or nonexistent tasks", () => {
  const out = runScript(makeIgnoredBlockersProjectRoot());
  assert.match(out, /task 1: unblocked/);
  assert.match(out, /task 3: unblocked/);
});

test("no legacy blockedBy key survives in the real project task data", () => {
  const legacyKey = ["task", "Num"].join("");
  const legacyKeyPattern = new RegExp(`"${legacyKey}"`);
  const tasksJson = readFileSync(join(import.meta.dirname, "..", ".taskTools", "tasks.json"), "utf8");
  const completedTasksJson = readFileSync(join(import.meta.dirname, "..", ".taskTools", "completedTasks.json"), "utf8");
  assert.doesNotMatch(tasksJson, legacyKeyPattern);
  assert.doesNotMatch(completedTasksJson, legacyKeyPattern);
});
