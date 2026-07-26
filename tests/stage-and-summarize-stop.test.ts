// Behavioral checks for stage-and-summarize-stop.ts: it speaks up exactly once
// when a recorded file is still unstaged (consuming the flag), and stays silent
// when no flag exists, when the recorded files are already staged, when the
// files are outside a repo, or when stop_hook_active guards against a loop.
// Run with: node --test "tests/*.test.ts"
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

function homeWithFlag(sid: string, paths: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "hook-stop-"));
  mkdirSync(join(home, ".claude", "turn-flags"), { recursive: true });
  writeFileSync(join(home, ".claude", "turn-flags", sid), paths.map((p) => `${p}\n`).join(""));
  return home;
}

// A throwaway repo with one edited file; stage it when `staged` is set.
function repoWithEdit(staged: boolean): string {
  const repo = mkdtempSync(join(tmpdir(), "hook-repo-"));
  const file = join(repo, "edited.txt");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(file, "hello\n");
  if (staged) git("add", file);
  return file;
}

test("unstaged edit: emits Stop additionalContext once, consumes flag", () => {
  const home = homeWithFlag("s1", [repoWithEdit(false)]);
  const out = JSON.parse(run(home, { session_id: "s1", stop_hook_active: false }));
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.match(out.hookSpecificOutput.additionalContext, /COMMIT_MESSAGES\.md/);
  assert.equal(existsSync(join(home, ".claude", "turn-flags", "s1")), false);
  assert.equal(run(home, { session_id: "s1", stop_hook_active: false }), "");
});

test("already staged: silent", () => {
  const home = homeWithFlag("s1", [repoWithEdit(true)]);
  assert.equal(run(home, { session_id: "s1", stop_hook_active: false }), "");
});

test("file outside any git repo: silent", () => {
  const home = homeWithFlag("s1", [join(mkdtempSync(join(tmpdir(), "hook-bare-")), "x.txt")]);
  assert.equal(run(home, { session_id: "s1", stop_hook_active: false }), "");
});

test("no flag: silent", () => {
  const home = mkdtempSync(join(tmpdir(), "hook-stop-"));
  assert.equal(run(home, { session_id: "s1", stop_hook_active: false }), "");
});

test("stop_hook_active: silent even with flag set", () => {
  const home = homeWithFlag("s1", [repoWithEdit(false)]);
  assert.equal(run(home, { session_id: "s1", stop_hook_active: true }), "");
});
