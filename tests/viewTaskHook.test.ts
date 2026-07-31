// viewTaskHook.ts: /view-task prompts get a block-decision JSON answer; other prompts pass through silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dirname, "..", "scripts", "viewTaskHook.ts");

function runHook(prompt: string, cwd: string): string {
  return execFileSync("node", ["--no-inspect", HOOK], {
    input: JSON.stringify({ prompt, cwd }),
    cwd,
    encoding: "utf8",
  });
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-hook-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 1, title: "first task", description: "line one\nline two" }]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  return root;
}

test("hook loads and answers /view-task with a block decision", () => {
  const out = runHook("/view-task 1", makeProjectRoot());
  const decision = JSON.parse(out);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /first task/);
});

test("hook is silent passthrough for other prompts", () => {
  const out = runHook("unrelated prompt", makeProjectRoot());
  assert.equal(out, "");
});

test("/view-task <N> includes the task's description with real newlines", () => {
  const decision = JSON.parse(runHook("/view-task 1", makeProjectRoot()));
  assert.ok(decision.reason.includes("Task 1 (OPEN): first task"));
  assert.ok(decision.reason.includes("line one\nline two"));
});

test("/view-task with no number blocks with usage and the open-task listing", () => {
  const decision = JSON.parse(runHook("/view-task", makeProjectRoot()));
  assert.equal(decision.decision, "block");
  assert.ok(decision.reason.startsWith("Usage: /view-task <N...>"));
  assert.match(decision.reason, /1: first task/);
});

test("unknown task number reports not-found instead of crashing", () => {
  const decision = JSON.parse(runHook("/view-task 99999", makeProjectRoot()));
  assert.ok(decision.reason.includes("Task 99999: not found"));
});
