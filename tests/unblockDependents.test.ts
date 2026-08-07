// unblockDependents.ts: removes closed numbers from blockedBy, drops it when empty. Untouched entries stay byte-identical.
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
      { taskNumber: 2, title: "fully blocked", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
      { taskNumber: 4, title: "partly blocked", blockedBy: [{ taskNum: 1, reason: "needs task 1" }, { taskNum: 3, reason: "needs task 3" }] },
      { taskNumber: 5, title: "unrelated" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("removes closed number, drops emptied blockedBy, keeps other blockers and their reason", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 2), false);
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 4).blockedBy, [{ taskNum: 3, reason: "needs task 3" }]);
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

test("migrates a legacy bare-number blockedBy entry and still filters it when its blocker closes", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-legacy-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 6, title: "legacy blocker", blockedBy: [1] }]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 6), false);
  assert.match(out, /task\(s\): 6/);
});

test("migrates a legacy bare-number entry to the object shape even when its blocker is not the one closing", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-legacy-survive-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 7, title: "legacy blocker", blockedBy: [1] }]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  const out = runScript(root, "99");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 7).blockedBy, [
    { taskNum: 1, reason: "reason not recorded (migrated from legacy blockedBy format)" },
  ]);
  assert.match(out, /no blockedBy references/);
});
