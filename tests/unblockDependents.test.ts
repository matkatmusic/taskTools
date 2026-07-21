// Behavioral checks for unblockDependents.ts: closed task numbers are removed
// from every tasks.json entry's blockedBy array, and the field is dropped
// entirely when it empties. Untouched entries stay byte-identical.
// Run with: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "unblockDependents.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 2, title: "fully blocked", blockedBy: [1] },
      { taskNumber: 4, title: "partly blocked", blockedBy: [1, 3] },
      { taskNumber: 5, title: "unrelated" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("removes closed number, drops emptied blockedBy, keeps other blockers", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 2), false);
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 4).blockedBy, [3]);
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 5), false);
  assert.match(out, /task\(s\): 2, 4/);
});

test("no matching blockers leaves tasks.json untouched", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "99");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
  assert.match(out, /no blockedBy references/);
});
