// Disabled: scripts/tackle-tasks/tackleTasksHook.ts is unregistered from hooks.json on the v1.6 launch path; these tests assert the retired `valid` brief.
/*
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/tackle-tasks/tackleTasksHook.ts", import.meta.url));

function withProject(tasks: unknown[], run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tackle-tasks-hook-"));
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks));
  writeFileSync(join(dir, "completedTasks.json"), "[]");
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(prompt: string, cwd: string): { code: number | null; stdout: string } {
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify({ prompt, cwd }),
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout };
}

test("non /tackle-tasks prompt exits 0 with no output", () => {
  withProject([], dir => {
    const { code, stdout } = runHook("/other-command foo", dir);
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("single blocked task prints its direct blocker and stops the run", () => {
  withProject(
    [
      { taskNumber: 75, title: "t75" },
      { taskNumber: 84, title: "t84", blockedBy: [{ taskNumber: 75, reason: "needs 75 first" }] },
    ],
    dir => {
      const { code, stdout } = runHook("/tackle-tasks [84] valid", dir);
      assert.equal(code, 0);
      const out = JSON.parse(stdout);
      assert.equal(out.decision, "block");
      assert.equal(out.reason, "[84] blocked by: 75: needs 75 first\nrun 'tackle-tasks [75] valid' first");
      assert.equal(out.hookSpecificOutput, undefined);
    },
  );
});

test("multi-task run reports only the blocked tasks and continues with the rest", () => {
  withProject(
    [
      { taskNumber: 2, title: "t2" },
      { taskNumber: 3, title: "t3", blockedBy: [{ taskNumber: 2, reason: "r" }] },
      { taskNumber: 4, title: "t4" },
      { taskNumber: 5, title: "t5", blockedBy: [{ taskNumber: 2, reason: "r" }] },
      { taskNumber: 8, title: "t8" },
      { taskNumber: 12, title: "t12" },
    ],
    dir => {
      const { code, stdout } = runHook("/tackle-tasks [3,4,5,8,12] valid", dir);
      assert.equal(code, 0);
      const out = JSON.parse(stdout);
      assert.equal(out.decision, "block");
      assert.equal(out.reason, "[3] blocked by: 2: r\n[5] blocked by: 2: r\nrun 'tackle-tasks [2] valid' first");
      assert.ok(out.hookSpecificOutput.additionalContext.includes("[4,8,12] valid"));
    },
  );
});

test("fully unblocked run still hands the agent the generated skill body", () => {
  withProject([{ taskNumber: 84, title: "t84" }], dir => {
    const { code, stdout } = runHook("/tackle-tasks [84] valid", dir);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
    assert.equal(out.reason, undefined);
    assert.ok(out.hookSpecificOutput.additionalContext.includes("[84] valid"));
  });
});

test("plugin-namespaced prompt is recognized the same as the bare command", () => {
  withProject([{ taskNumber: 84, title: "t84" }], dir => {
    const { code, stdout } = runHook("/taskTools:tackle-tasks [84] valid", dir);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
  });
});

*/
