import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clarifyTask } from "../scripts/clarifyTask.ts";

const scriptPath = fileURLToPath(new URL("../scripts/clarifyTask.ts", import.meta.url));

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clarifyTask-"));
  mkdirSync(join(root, ".taskTools"));
  const worktree = join(root, "task-1");
  mkdirSync(join(worktree, "plans"), { recursive: true });
  writeFileSync(join(worktree, "plans", "checkpoint.json"), "{}\n");
  const tasks = [
    { taskNumber: 1, title: "answered later", description: "body", files: ["a.ts"], clarifyRequest: "where is X?",
      run: { active: false, worktree, history: [
        { runId: "r1", attempts: { clarify: 1 }, countedPasses: { clarify: ["p1"] } },
        { runId: "r2", attempts: { clarify: 2 }, countedPasses: { clarify: ["p2", "p3"] } },
      ] } },
    { taskNumber: 2, title: "no question", description: "body" },
  ];
  writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify(tasks, null, 2) + "\n");
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
  return root;
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"));
}

test("test_clarifyTaskRecordsTheAnswerAndClearsEveryHistoryEntrysAttemptCounters", () => {
  const root = makeProjectRoot();
  clarifyTask({ taskNumber: 1, answer: "X lives in b.ts", files: ["b.ts", "a.ts"], blockedBy: [{ taskNumber: 9, reason: "defines X" }] }, root);
  const task = readTasks(root)[0];
  assert.match(task.description, /^body\n\n## Clarification answer \(\d{4}-\d{2}-\d{2}\)\n\nX lives in b\.ts$/);
  assert.deepEqual(task.files, ["a.ts", "b.ts"]);
  assert.deepEqual(task.blockedBy, [{ taskNumber: 9, reason: "defines X" }]);
  assert.equal("clarifyRequest" in task, false);
  for (const record of task.run.history) {
    assert.equal("attempts" in record, false);
    assert.equal("countedPasses" in record, false);
  }
  assert.deepEqual(task.run.history.map((r: any) => r.runId), ["r1", "r2"]);
  assert.equal(existsSync(join(task.run.worktree, "plans", "checkpoint.json")), false);
});

test("test_clarifyTaskRefusesATaskWithNoClarifyRequest", () => {
  const root = makeProjectRoot();
  assert.throws(() => clarifyTask({ taskNumber: 2, answer: "anything" }, root), /no clarifyRequest/);
  assert.equal(readTasks(root)[1].description, "body");
});

test("test_clarifyTaskScriptReadsTheAnswerFromStdin", () => {
  const root = makeProjectRoot();
  const out = execFileSync("node", [scriptPath], { cwd: root, encoding: "utf8", input: JSON.stringify({ taskNumber: 1, answer: "via stdin" }) });
  assert.match(out, /^answered task 1; files: \["a\.ts"\]; blockedBy: \[\]; run attempts cleared; checkpoint removed\n$/);
  assert.match(readTasks(root)[0].description, /via stdin$/);
});
