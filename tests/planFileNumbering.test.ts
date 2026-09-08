import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTaskFile, resolveTaskFiles } from "../scripts/shared/taskFiles.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function driftingPlanFiles(): string[] {
  const pair = resolveTaskFiles(repoRoot);
  const known = new Set(
    [...readTaskFile(pair.tasksPath), ...readTaskFile(pair.completedTasksPath)].map((task) => task.taskNumber),
  );
  const drift: string[] = [];
  for (const file of readdirSync(join(repoRoot, "plans"))) {
    const match = file.match(/^brief-(\d+)\.md$/) ?? file.match(/^task-(\d+)-plan\.md$/);
    if (match && !known.has(Number(match[1]))) drift.push(file);
  }
  return drift.sort();
}

test("every plans/brief-N.md and plans/task-N-plan.md names a task number that exists in tasks.json or completedTasks.json", () => {
  assert.deepEqual(driftingPlanFiles(), []);
});

test("renumbered closing-chain files contain their current task numbers", () => {
  const renumbered = [
    ["brief-162.md", 162],
    ["task-162-plan.md", 162],
    ["brief-163.md", 163],
    ["task-163-plan.md", 163],
  ] as const;

  for (const [file, taskNumber] of renumbered) {
    const body = readFileSync(join(repoRoot, "plans", file), "utf8");
    assert.match(body, new RegExp(`^# Task ${taskNumber}\\b`), file);
    assert.doesNotMatch(body, /\b[Tt]ask (?:156|157)\b/, file);
  }
});
