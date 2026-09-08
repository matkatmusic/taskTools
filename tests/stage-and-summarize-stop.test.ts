// Behavioral checks for stage-and-summarize-stop.ts's unstaged-file reminder and its guards.  Run with: node --test "tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "hooks", "stage-and-summarize-stop.ts");
const FLAG_SCRIPT = join(import.meta.dirname, "..", "scripts", "hooks", "turn-modified-flag.ts");

function runFlag(home: string, args: string[], input: object): void {
  execFileSync("node", ["--no-inspect", FLAG_SCRIPT, ...args], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home },
  });
}

function snapshot(home: string, sid: string, file: string): void {
  runFlag(home, ["--snapshot"], { session_id: sid, tool_input: { file_path: file } });
}

function modified(home: string, sid: string, file: string): void {
  runFlag(home, [], { session_id: sid, tool_input: { file_path: file } });
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function repoWithCommittedFiles(): { repo: string; first: string; second: string; third: string } {
  const repo = mkdtempSync(join(tmpdir(), "hook-repo-"));
  const first = join(repo, "first.txt");
  const second = join(repo, "second.txt");
  const third = join(repo, "third.txt");
  const gitArgs = (...args: string[]) => git(repo, ...args);
  gitArgs("init", "-q");
  gitArgs("config", "user.email", "hook-test@example.com");
  gitArgs("config", "user.name", "Hook Test");
  for (const file of [first, second, third]) writeFileSync(file, "one\ntwo\nthree\nfour\n");
  gitArgs("add", ".");
  gitArgs("commit", "-qm", "initial");
  return { repo, first, second, third };
}

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

// test("test_stages_only_the_flagged_session_files", () => {
//   // Three dirty files; session recorded two. Snapshot those two, edit all three, record the two, then run Stop.
//   const { repo, first, second, third } = repoWithCommittedFiles();
//   const home = mkdtempSync(join(tmpdir(), "hook-stop-"));
//   snapshot(home, "s1", first);
//   snapshot(home, "s1", second);
//   writeFileSync(first, "one session first\ntwo\nthree\nfour\n");
//   writeFileSync(second, "one\ntwo session second\nthree\nfour\n");
//   writeFileSync(third, "one\ntwo\nthree earlier\nfour\n");
//   modified(home, "s1", first);
//   modified(home, "s1", second);
// 
//   // Exactly the two listed session paths enter the index; the third remains unstaged.
//   const out = JSON.parse(run(home, { session_id: "s1", stop_hook_active: false }));
//   assert.deepEqual(git(repo, "diff", "--cached", "--name-only").trim().split("\n").sort(), ["first.txt", "second.txt"]);
//   assert.match(git(repo, "diff", "--", "third.txt"), /\+three earlier/);
//   assert.match(out.hookSpecificOutput.additionalContext, /commit-message skill/);
// });

test("test_stages_only_the_session_hunk_in_a_file_with_an_earlier_hunk", () => {
  // A tracked file holds an earlier hunk and this session's hunk. Snapshot first, add session hunk, run Stop.
  const { repo, first } = repoWithCommittedFiles();
  const home = mkdtempSync(join(tmpdir(), "hook-stop-"));
  writeFileSync(first, "one earlier\ntwo\nthree\nfour\n");
  snapshot(home, "s1", first);
  writeFileSync(first, "one earlier\ntwo\nthree session\nfour\n");
  modified(home, "s1", first);

  // The cache contains only the session hunk, and the older hunk remains a worktree diff.
  run(home, { session_id: "s1", stop_hook_active: false });
  const cached = git(repo, "diff", "--cached", "--", "first.txt");
  assert.match(cached, /\+three session/);
  assert.doesNotMatch(cached, /one earlier/);
  assert.match(git(repo, "diff", "--", "first.txt"), /\+one earlier/);
});

test("test_empty_session_stages_nothing_and_does_not_request_a_commit_message", () => {
  // Scenario: no completed file write was recorded for this session.  Steps: create an empty flag and run Stop.
  const home = homeWithFlag("s1", []);
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

test("test_missing_or_unreadable_flag_stages_nothing_and_explains_why", () => {
  // No usable completed-write list: run with none, then with the list path as a directory.
  const home = mkdtempSync(join(tmpdir(), "hook-stop-"));
  const missing = spawnSync("node", ["--no-inspect", SCRIPT], {
    input: JSON.stringify({ session_id: "s1", stop_hook_active: false }),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /staging nothing/i);
  mkdirSync(join(home, ".claude", "turn-flags", "s1"), { recursive: true });
  const unreadable = spawnSync("node", ["--no-inspect", SCRIPT], {
    input: JSON.stringify({ session_id: "s1", stop_hook_active: false }),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(unreadable.status, 0);
  assert.equal(unreadable.stdout, "");
  assert.match(unreadable.stderr, /staging nothing/i);
});

test("stop_hook_active: silent even with flag set", () => {
  const home = homeWithFlag("s1", [repoWithEdit(false)]);
  assert.equal(run(home, { session_id: "s1", stop_hook_active: true }), "");
});

test("test_stopHookExitsCleanlyWhenTheTurnFlagIsRemovedByAConcurrentSubagent", async () => {
  // FIFO pauses the hook mid-read so we can unlink the flag before its rmSync runs.
  const home = mkdtempSync(join(tmpdir(), "hook-stop-race-"));
  mkdirSync(join(home, ".claude", "turn-flags"), { recursive: true });
  const flagPath = join(home, ".claude", "turn-flags", "s1");
  execFileSync("mkfifo", [flagPath]);

  const child = spawn("node", ["--no-inspect", SCRIPT], { env: { ...process.env, HOME: home } });
  child.stdin.write(JSON.stringify({ session_id: "s1", stop_hook_active: false }));
  child.stdin.end();

  let writeFd = -1;
  while (writeFd < 0) {
    try {
      writeFd = openSync(flagPath, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  unlinkSync(flagPath);
  writeSync(writeFd, "\n");
  closeSync(writeFd);

  const exitCode: number = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  assert.equal(exitCode, 0);
});
