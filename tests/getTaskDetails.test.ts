// getTaskDetails.ts: no-arg listing marks blocked tasks with [blockedBy: ...] for pick-a-task/tackle-tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "getTaskDetails.ts");

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-details-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "unblocked task" },
      { taskNumber: 2, title: "blocked task", blockedBy: [1, 3] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "done task" }]));
  return root;
}

test("listing marks blocked tasks and leaves unblocked ones plain", () => {
  const out = runScript(makeProjectRoot());
  assert.match(out, /OPEN 1: unblocked task\n/);
  assert.match(out, /OPEN 2: blocked task \[blockedBy: 1,3\]/);
  assert.doesNotMatch(out, /unblocked task \[blockedBy/);
  assert.match(out, /DONE 3: done task\n/);
});

test("digits inside trailing prose are not treated as task numbers", () => {
  const out = runScript(
    makeProjectRoot(),
    "1 closureNote: Verified NO (2026-07-21) — see task 2, stall 2252s (task 3, still open).",
  );
  assert.match(out, /task 1 \(OPEN\)/);
  assert.doesNotMatch(out, /task (2|3|2026|2252)[ :(]/);
});

test("a JSON array first argument closes the batch the skill named", () => {
  // close-tasks passes details via '$1', the no-space JSON array token that survives quoted closureNotes.
  const root = makeProjectRoot();
  for (const arg of ["[1,2]", '"[1,2]"', "1,2"]) {
    const out = runScript(root, arg);
    assert.match(out, /task 1 \(OPEN\)/, `${arg} should resolve task 1`);
    assert.match(out, /task 2 \(OPEN\)/, `${arg} should resolve task 2`);
  }
});

test("full details include the blockedBy field", () => {
  const out = runScript(makeProjectRoot(), "2");
  assert.match(out, /task 2 \(OPEN\)/);
  assert.deepEqual(JSON.parse(out.slice(out.indexOf("{"))).blockedBy, [1, 3]);
});

test("findTask resolves open first, falls back to completed, and importing runs no CLI", async () => {
  const root = makeProjectRoot();
  const { findTask } = await import("../scripts/getTaskDetails.ts");
  assert.equal(findTask(1, root)?.title, "unblocked task");
  assert.equal(findTask(3, root)?.title, "done task");
  assert.equal(findTask(99, root), undefined);
});
