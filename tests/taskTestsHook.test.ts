import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/hooks/taskTestsHook.ts", import.meta.url));

// A throwaway package whose `npm test` prints whatever the caller wants. Returns the resolved, symlink-free path.
function fakeRepoWhoseTestPrints(shellLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), "task-tests-hook-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake", scripts: { test: shellLine } }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function runHook(prompt: string, cwd: string): string {
  return execFileSync("node", [hookPath], { input: JSON.stringify({ prompt, cwd }), encoding: "utf8" });
}

function runHookWithPayload(payload: unknown): string {
  return execFileSync("node", [hookPath], { input: JSON.stringify(payload), encoding: "utf8" });
}

test("exits silently for a prompt that is not /task-tests", () => {
  assert.equal(runHook("hello there", process.cwd()), "");
});

test("on failures, adds context naming each failing test with its file and the subagent instructions, and never blocks", () => {
  const reporterTail = "✖ boom (1ms)\\nℹ fail 1\\n✖ failing tests:\\n\\ntest at tests/a.test.ts:12:1\\n✖ boom (1ms)\\n";
  const cwd = fakeRepoWhoseTestPrints(`printf '${reporterTail}'`);
  const parsed = JSON.parse(runHook("/task-tests", cwd));
  assert.equal(parsed.decision, undefined);
  const context: string = parsed.hookSpecificOutput.additionalContext;
  assert.match(context, /Spawn ONE subagent/);
  assert.match(context, /First invoke `\/ponytail ultra`/);
  assert.match(context, /^- tests\/a\.test\.ts — boom$/m);
});

test("adds 'all tests passed' as context when the suite reports zero failures", () => {
  const cwd = fakeRepoWhoseTestPrints("printf 'ℹ pass 3\\nℹ fail 0\\n'");
  const parsed = JSON.parse(runHook("/taskTools:task-tests", cwd));
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.hookSpecificOutput.additionalContext, /^all tests passed; recorded 0 known failing tests in/);
});

test("test_taskTestsHook_recordsFailingTestsAsKnownBaseline", () => {
  const reporterTail = "✖ boom (1ms)\\nℹ fail 1\\n✖ failing tests:\\n\\ntest at tests/a.test.ts:12:1\\n✖ boom (1ms)\\n";
  const cwd = fakeRepoWhoseTestPrints(`printf '${reporterTail}'`);
  runHook("/task-tests", cwd);
  const baseline = JSON.parse(readFileSync(join(cwd, ".taskTools", "knownFailingTests.json"), "utf8"));
  assert.deepEqual(baseline, [{ file: "tests/a.test.ts", name: "boom" }]);
});

test("test_taskTestsHook_runsForASkillCallWithAPath", () => {
  const reporterTail = "✖ boom (1ms)\\nℹ fail 1\\n✖ failing tests:\\n\\ntest at tests/a.test.ts:12:1\\n✖ boom (1ms)\\n";
  const cwd = fakeRepoWhoseTestPrints(`printf '${reporterTail}'`);
  runHookWithPayload({ hook_event_name: "PreToolUse", tool_input: { skill: "taskTools:task-tests", args: cwd } });
  const baseline = JSON.parse(readFileSync(join(cwd, ".taskTools", "knownFailingTests.json"), "utf8"));
  assert.deepEqual(baseline, [{ file: "tests/a.test.ts", name: "boom" }]);
});
