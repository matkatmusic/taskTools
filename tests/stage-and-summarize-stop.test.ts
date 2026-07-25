// Behavioral checks for stage-and-summarize-stop.ts: with a flag set it blocks
// the stop exactly once (consuming the flag); it stays silent when no flag
// exists or when stop_hook_active guards against a loop.
// Run with: node --test ~/.claude/hooks/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "stage-and-summarize-stop.ts");

function run(home: string, input: object): string {
  return execFileSync("node", ["--no-inspect", SCRIPT], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function homeWithFlag(sid: string): string {
  const home = mkdtempSync(join(tmpdir(), "hook-stop-"));
  mkdirSync(join(home, ".claude", "turn-flags"), { recursive: true });
  writeFileSync(join(home, ".claude", "turn-flags", sid), "");
  return home;
}

test("flag set: emits Stop additionalContext once, consumes flag", () => {
  const home = homeWithFlag("s1");
  const out = JSON.parse(run(home, { session_id: "s1", stop_hook_active: false }));
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.match(out.hookSpecificOutput.additionalContext, /COMMIT_MESSAGES\.md/);
  assert.equal(existsSync(join(home, ".claude", "turn-flags", "s1")), false);
  assert.equal(run(home, { session_id: "s1", stop_hook_active: false }), "");
});

test("no flag: silent", () => {
  const home = mkdtempSync(join(tmpdir(), "hook-stop-"));
  assert.equal(run(home, { session_id: "s1", stop_hook_active: false }), "");
});

test("stop_hook_active: silent even with flag set", () => {
  const home = homeWithFlag("s1");
  assert.equal(run(home, { session_id: "s1", stop_hook_active: true }), "");
});
