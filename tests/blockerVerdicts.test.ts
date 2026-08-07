// Tests blockerVerdicts.ts exports and its stdin-driven strip CLI. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKER_VERDICTS,
  BLOCKER_VERDICT_VALUES,
  BLOCKER_VERDICT_SCHEMA_FRAGMENT,
  buildBlockerInvestigationPrompt,
} from "../scripts/blockerVerdicts.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "blockerVerdicts.ts");

test("exports the verdict vocabulary, derived values, and schema fragment", () => {
  assert.deepEqual(BLOCKER_VERDICTS, { DISPROVEN: "disproven", STILL_BLOCKED: "still-blocked" });
  assert.deepEqual(BLOCKER_VERDICT_VALUES, ["disproven", "still-blocked"]);
  assert.deepEqual(BLOCKER_VERDICT_SCHEMA_FRAGMENT, { type: "string", enum: ["disproven", "still-blocked"] });
});

test("buildBlockerInvestigationPrompt renders the exact investigation question", () => {
  assert.equal(
    buildBlockerInvestigationPrompt(70, 69, "needs task 69"),
    "Find out if task 70 is actually blocked by task 69 due to: needs task 69",
  );
});

const METACHAR_REASON = 'needs "task 1" $(rm -rf /) `whoami` \\ backslash 日本語 emoji 🎉';
const MULTILINE_REASON = "needs task 1\nsee also task 5\nand the docs";

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-blockerVerdicts-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      {
        taskNumber: 2,
        title: "blocked by two claims against the same task",
        blockedBy: [
          { taskNum: 1, reason: "needs task 1" },
          { taskNum: 1, reason: "also needs task 1 for docs" },
          { taskNum: 5, reason: "needs task 5" },
        ],
      },
      { taskNumber: 4, title: "blocked by one", blockedBy: [{ taskNum: 3, reason: "needs task 3" }] },
      {
        taskNumber: 6,
        title: "blocked by two identical claims",
        blockedBy: [
          { taskNum: 1, reason: "needs task 1" },
          { taskNum: 1, reason: "needs task 1" },
        ],
      },
      { taskNumber: 7, title: "blocked with an empty reason", blockedBy: [{ taskNum: 1, reason: "" }] },
      { taskNumber: 8, title: "blocked with shell metacharacters", blockedBy: [{ taskNum: 1, reason: METACHAR_REASON }] },
      { taskNumber: 9, title: "blocked with a multi-line reason", blockedBy: [{ taskNum: 1, reason: MULTILINE_REASON }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
  return root;
}

function runScript(cwd: string, blockedArg: string, blockerArg: string, reason: string): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, blockedArg, blockerArg], {
    cwd,
    encoding: "utf8",
    input: reason + "\n",
  });
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

test("removes only the exact matching entry, keeping a same-taskNum entry with a different reason", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "2", "1", "needs task 1");
  assert.equal(out, "removed blockedBy entry from task 2 for blocker task 1\n");
  const task2 = readTasks(root).find((t: any) => t.taskNumber === 2);
  assert.deepEqual(task2.blockedBy, [
    { taskNum: 1, reason: "also needs task 1 for docs" },
    { taskNum: 5, reason: "needs task 5" },
  ]);
});

test("deletes blockedBy entirely when the last entry is removed", () => {
  const root = makeProjectRoot();
  runScript(root, "4", "3", "needs task 3");
  const task4 = readTasks(root).find((t: any) => t.taskNumber === 4);
  assert.equal("blockedBy" in task4, false);
});

test("reports no match and leaves tasks.json untouched when the reason doesn't match", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "2", "1", "some other reason entirely");
  assert.equal(out, "no matching blockedBy entry for task 2 blocked by task 1 with that reason\n");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("reports no match and leaves tasks.json untouched when the pair doesn't exist", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "2", "99", "needs task 99");
  assert.equal(out, "no matching blockedBy entry for task 2 blocked by task 99 with that reason\n");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("two identical blockedBy entries: one CLI invocation removes exactly one", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "6", "1", "needs task 1");
  assert.equal(out, "removed blockedBy entry from task 6 for blocker task 1\n");
  const task6 = readTasks(root).find((t: any) => t.taskNumber === 6);
  assert.deepEqual(task6.blockedBy, [{ taskNum: 1, reason: "needs task 1" }]);
});

test("removes a blockedBy entry whose reason is the empty string", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "7", "1", "");
  assert.equal(out, "removed blockedBy entry from task 7 for blocker task 1\n");
  const task7 = readTasks(root).find((t: any) => t.taskNumber === 7);
  assert.equal("blockedBy" in task7, false);
});

test("a reason with Unicode and shell metacharacters survives the heredoc round trip unchanged", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "8", "1", METACHAR_REASON);
  assert.equal(out, "removed blockedBy entry from task 8 for blocker task 1\n");
  const task8 = readTasks(root).find((t: any) => t.taskNumber === 8);
  assert.equal("blockedBy" in task8, false);
});

test("a multi-line reason survives the heredoc round trip unchanged", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "9", "1", MULTILINE_REASON);
  assert.equal(out, "removed blockedBy entry from task 9 for blocker task 1\n");
  const task9 = readTasks(root).find((t: any) => t.taskNumber === 9);
  assert.equal("blockedBy" in task9, false);
});
