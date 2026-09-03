import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/taskTestsHook.ts", import.meta.url));

// A throwaway package whose `npm test` prints whatever the caller wants.
function fakeRepoWhoseTestPrints(shellLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), "task-tests-hook-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake", scripts: { test: shellLine } }));
  return dir;
}

function runHook(prompt: string, cwd: string): string {
  return execFileSync("node", [hookPath], { input: JSON.stringify({ prompt, cwd }), encoding: "utf8" });
}

test("exits silently for a prompt that is not /task-tests", () => {
  assert.equal(runHook("hello there", process.cwd()), "");
});

test("blocks with the failing test lines when the suite reports failures", () => {
  const cwd = fakeRepoWhoseTestPrints("printf '✖ boom (1ms)\\nℹ fail 1\\n'");
  const parsed = JSON.parse(runHook("/task-tests", cwd));
  assert.equal(parsed.decision, "block");
  assert.equal(parsed.reason, "✖ boom (1ms)");
});

test("adds 'all tests passed' as context when the suite reports zero failures", () => {
  const cwd = fakeRepoWhoseTestPrints("printf 'ℹ pass 3\\nℹ fail 0\\n'");
  const parsed = JSON.parse(runHook("/taskTools:task-tests", cwd));
  assert.equal(parsed.decision, undefined);
  assert.equal(parsed.hookSpecificOutput.additionalContext, "all tests passed");
});
