// Behavioral check for turn-modified-flag.ts: piping PostToolUse JSON creates
// the per-session flag file under $HOME/.claude/turn-flags/.
// Run with: node --test ~/.claude/hooks/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "turn-modified-flag.ts");

test("creates the session flag file", () => {
  const home = mkdtempSync(join(tmpdir(), "hook-flag-"));
  execFileSync("node", ["--no-inspect", SCRIPT], {
    input: JSON.stringify({ session_id: "s1", tool_name: "Edit" }),
    env: { ...process.env, HOME: home },
  });
  assert.equal(existsSync(join(home, ".claude", "turn-flags", "s1")), true);
});

test("missing session_id does nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "hook-flag-"));
  execFileSync("node", ["--no-inspect", SCRIPT], {
    input: "{}",
    env: { ...process.env, HOME: home },
  });
  assert.equal(existsSync(join(home, ".claude", "turn-flags")), false);
});
