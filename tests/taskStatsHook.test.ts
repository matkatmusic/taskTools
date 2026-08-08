import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { computeTaskStats, formatTaskStats } from "../scripts/taskStats.ts";
import { readTaskFile, resolveTaskFiles } from "../scripts/taskFiles.ts";

const hookPath = fileURLToPath(new URL("../scripts/taskStatsHook.ts", import.meta.url));
const repoRoot = process.cwd();

test("resolves task files from payload.cwd, not the process cwd", () => {
  const payload = JSON.stringify({ prompt: "/task-stats", cwd: repoRoot });
  // tmpdir() has no tasks.json, so passing proves the hook used payload.cwd.
  const output = execFileSync("node", [hookPath], { input: payload, encoding: "utf8", cwd: tmpdir() });
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "block");

  const pair = resolveTaskFiles(repoRoot);
  const today = new Date().toISOString().slice(0, 10);
  const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today);
  assert.equal(parsed.reason, formatTaskStats(stats));
});

test("blocks /task-stats with a trailing argument", () => {
  const payload = JSON.stringify({ prompt: "/task-stats extra", cwd: repoRoot });
  const output = execFileSync("node", [hookPath], { input: payload, encoding: "utf8" });
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "block");
});

test("exits silently for a prompt that is not /task-stats", () => {
  const payload = JSON.stringify({ prompt: "hello there", cwd: repoRoot });
  const output = execFileSync("node", [hookPath], { input: payload, encoding: "utf8" });
  assert.equal(output, "");
});
