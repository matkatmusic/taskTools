// Behavior: queryTasks.ts answers "what blocks task N" and "which open tasks touch file X" from a fixture tasks.json, with no agent and no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function makeFixture(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "queryTasks-"));
  mkdirSync(join(projectRoot, ".taskTools"), { recursive: true });
  const tasks = [
    { taskNumber: 1, title: "Task A", modifiableFiles: ["scripts/foo.ts"], blockedBy: [{ taskNumber: 2, reason: "B blocks A" }] },
    { taskNumber: 2, title: "Task B", modifiableFiles: [], blockedBy: [{ taskNumber: 3, reason: "C blocks B" }] },
    { taskNumber: 3, title: "Task C", modifiableFiles: ["scripts/foo.ts"], blockedBy: [] },
  ];
  writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), JSON.stringify(tasks));
  writeFileSync(join(projectRoot, ".taskTools", "completedTasks.json"), JSON.stringify([]));
  return projectRoot;
}

function runQueryTasks(projectRoot: string, args: string[]): string {
  const scriptPath = join(import.meta.dirname, "..", "scripts", "shared", "queryTasks.ts");
  return execFileSync("node", [scriptPath, ...args], { cwd: projectRoot, encoding: "utf8" });
}

test("test_blockers_prints_each_blocker_in_the_chain_with_title_and_reason", () => {
  // Scenario: task A is blocked by B, B is blocked by C; querying A's blockers walks the whole chain.
  const projectRoot = makeFixture();
  // Steps: run `queryTasks.ts blockers 1`
  const output = runQueryTasks(projectRoot, ["blockers", "1"]);
  // the output names blocker B, its title, and the reason A is blocked by B
  assert.match(output, /2: Task B \(B blocks A\)/);
  // the output names blocker C, its title, and the reason B is blocked by C
  assert.match(output, /3: Task C \(C blocks B\)/);
  rmSync(projectRoot, { recursive: true, force: true });
});

test("test_files_prints_every_open_task_whose_modifiableFiles_contains_the_path", () => {
  // Scenario: tasks A and C both touch scripts/foo.ts; task B does not.
  const projectRoot = makeFixture();
  // Steps: run `queryTasks.ts files scripts/foo.ts`
  const output = runQueryTasks(projectRoot, ["files", "scripts/foo.ts"]);
  // the output names task A
  assert.match(output, /1: Task A/);
  // the output names task C
  assert.match(output, /3: Task C/);
  // the output does not name task B, which does not touch the file
  assert.doesNotMatch(output, /2: Task B/);
  rmSync(projectRoot, { recursive: true, force: true });
});
