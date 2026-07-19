// Behavioral checks for viewTaskHook.ts: /view-task prompts get a block-decision
// JSON answer; anything else passes through silently. Regression guard for the
// type-import crash that broke the hook on every prompt (Node type-stripping only
// erases `import type` imports).
// Run with: node --test tests/
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
  writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber: 1, title: "first task" }]));
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
