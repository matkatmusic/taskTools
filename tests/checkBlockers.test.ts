// checkBlockers.ts: a task is BLOCKED only by still-open blockers; closed ones don't count. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "checkBlockers.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "open blocker" },
      { taskNumber: 2, title: "blocked by open task", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
      { taskNumber: 4, title: "blocked only by closed task", blockedBy: [{ taskNum: 3, reason: "needs task 3" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "closed blocker" }]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("flags open blockers, ignores closed ones, passes unblocked tasks", () => {
  const out = runScript(makeProjectRoot(), "2", "4", "1");
  assert.match(out, /task 2: BLOCKED by open task\(s\) \[\{"taskNum":1,"reason":"needs task 1"\}\]/);
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
  assert.match(out, /task 2: BLOCKED by open task\(s\) \[\{"taskNum":1,"reason":"needs task 1"\}\]/);
  assert.match(out, /task 4: unblocked/);
});

test("non-numeric args like 'valid' are ignored", () => {
  const out = runScript(makeProjectRoot(), "2", "valid");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNum":1,"reason":"needs task 1"}]\n');
});

test("digits after prose are not task numbers, even as one quoted string", () => {
  const out = runScript(makeProjectRoot(), "2 valid see task 4 from 2026-07-21");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNum":1,"reason":"needs task 1"}]\n');
});
