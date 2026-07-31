// nextTaskNumber.ts: prints one past the highest taskNumber across both task files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "nextTaskNumber.ts");

function runScript(cwd: string): string {
  return execFileSync("node", ["--no-inspect", SCRIPT], { cwd, encoding: "utf8" });
}

test("prints the highest taskNumber across both task files, plus one", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-nextnum-"));
  writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber: 3, title: "a" }, { taskNumber: 5, title: "b" }]));
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 7, title: "c" }]));
  assert.equal(Number(runScript(root)), 8);
});

test("seeds empty task files in a fresh project and prints 1", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-nextnum-"));
  assert.equal(Number(runScript(root)), 1);
});
