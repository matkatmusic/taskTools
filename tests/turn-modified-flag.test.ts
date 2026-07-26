// Behavioral check for turn-modified-flag.ts: piping PostToolUse JSON appends
// the edited path to the per-session flag file under $HOME/.claude/turn-flags/.
// Run with: node --test "tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "turn-modified-flag.ts");

test("appends each edited path to the session flag file", () => {
  const home = mkdtempSync(join(tmpdir(), "hook-flag-"));
  for (const file_path of ["/a/one.ts", "/a/two.ts"]) {
    execFileSync("node", ["--no-inspect", SCRIPT], {
      input: JSON.stringify({ session_id: "s1", tool_name: "Edit", tool_input: { file_path } }),
      env: { ...process.env, HOME: home },
    });
  }
  const flag = readFileSync(join(home, ".claude", "turn-flags", "s1"), "utf8");
  assert.equal(flag, "/a/one.ts\n/a/two.ts\n");
});

test("missing session_id does nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "hook-flag-"));
  execFileSync("node", ["--no-inspect", SCRIPT], {
    input: "{}",
    env: { ...process.env, HOME: home },
  });
  assert.equal(existsSync(join(home, ".claude", "turn-flags")), false);
});
