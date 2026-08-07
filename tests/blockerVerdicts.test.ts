// blockerVerdicts.ts: exported verdict vocabulary/schema/prompt/token helpers, and the CLI that strips one exact disproven blockedBy entry. Run: node --test tests/*.test.ts
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
  encodeBlockerReasonToken,
  decodeBlockerReasonToken,
} from "../scripts/blockerVerdicts.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "blockerVerdicts.ts");

test("exports the verdict vocabulary, derived values, schema fragment, and a token round-trip for Unicode and shell-metacharacter reasons", () => {
  assert.deepEqual(BLOCKER_VERDICTS, { DISPROVEN: "disproven", STILL_BLOCKED: "still-blocked" });
  assert.deepEqual(BLOCKER_VERDICT_VALUES, ["disproven", "still-blocked"]);
  assert.deepEqual(BLOCKER_VERDICT_SCHEMA_FRAGMENT, { type: "string", enum: ["disproven", "still-blocked"] });
  const reason = 'needs "task 1" $(rm -rf /) `whoami` \\ backslash 日本語 emoji 🎉\nline two';
  const token = encodeBlockerReasonToken(reason);
  assert.match(token, /^r[A-Za-z0-9_-]*$/);
  assert.equal(decodeBlockerReasonToken(token), reason);
});

test("encodeBlockerReasonToken/decodeBlockerReasonToken round-trip an empty reason as the bare 'r' token", () => {
  const token = encodeBlockerReasonToken("");
  assert.equal(token, "r");
  assert.equal(decodeBlockerReasonToken(token), "");
});

test("buildBlockerInvestigationPrompt renders the exact investigation question", () => {
  assert.equal(
    buildBlockerInvestigationPrompt(70, 69, "needs task 69"),
    "Find out if task 70 is actually blocked by task 69 due to: needs task 69",
  );
});

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
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

test("removes only the exact matching entry, keeping a same-taskNum entry with a different reason", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "2", "1", encodeBlockerReasonToken("needs task 1"));
  assert.equal(out, "removed blockedBy entry from task 2 for blocker task 1\n");
  const task2 = readTasks(root).find((t: any) => t.taskNumber === 2);
  assert.deepEqual(task2.blockedBy, [
    { taskNum: 1, reason: "also needs task 1 for docs" },
    { taskNum: 5, reason: "needs task 5" },
  ]);
});

test("deletes blockedBy entirely when the last entry is removed", () => {
  const root = makeProjectRoot();
  runScript(root, "4", "3", encodeBlockerReasonToken("needs task 3"));
  const task4 = readTasks(root).find((t: any) => t.taskNumber === 4);
  assert.equal("blockedBy" in task4, false);
});

test("reports no match and leaves tasks.json untouched when the decoded reason doesn't match", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "2", "1", encodeBlockerReasonToken("some other reason entirely"));
  assert.equal(out, "no matching blockedBy entry for task 2 blocked by task 1 with that reason\n");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("reports no match and leaves tasks.json untouched when the pair doesn't exist", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "2", "99", encodeBlockerReasonToken("needs task 99"));
  assert.equal(out, "no matching blockedBy entry for task 2 blocked by task 99 with that reason\n");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("two identical blockedBy entries: one CLI invocation removes exactly one", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "6", "1", encodeBlockerReasonToken("needs task 1"));
  assert.equal(out, "removed blockedBy entry from task 6 for blocker task 1\n");
  const task6 = readTasks(root).find((t: any) => t.taskNumber === 6);
  assert.deepEqual(task6.blockedBy, [{ taskNum: 1, reason: "needs task 1" }]);
});

test("removes a blockedBy entry whose reason is the empty string, via the bare 'r' token", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "7", "1", encodeBlockerReasonToken(""));
  assert.equal(out, "removed blockedBy entry from task 7 for blocker task 1\n");
  const task7 = readTasks(root).find((t: any) => t.taskNumber === 7);
  assert.equal("blockedBy" in task7, false);
});
