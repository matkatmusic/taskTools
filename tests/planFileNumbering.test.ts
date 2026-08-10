import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTaskFile, resolveTaskFiles } from "../scripts/taskFiles.ts";

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
