// commitMessageSubagent.test.ts: stagedDiffs.ts prints a staged-diff section per affected repo. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "stagedDiffs.ts");

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function commitFile(dir: string, relPath: string, contents: string): void {
  writeFileSync(join(dir, relPath), contents);
  execFileSync("git", ["add", relPath], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function stageFile(dir: string, relPath: string, contents: string): void {
  writeFileSync(join(dir, relPath), contents);
  execFileSync("git", ["add", relPath], { cwd: dir });
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "taskTools-stagedDiffs-"));
}

function run(cwd: string): string {
  return execFileSync("node", ["--no-inspect", SCRIPT], { cwd, encoding: "utf8" });
}

test("prints the root repo's staged diff, labeled with its basename", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  stageFile(root, "a.txt", "two\n");
  const out = run(root);
  const label = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${label} ===\n`));
  assert.match(out, /-one\n\+two/);
});

test("prints nothing when there is nothing staged", () => {
  const root = newRoot();
  initRepo(root);
  assert.equal(run(root), "");
});

test("excludes tasks.json, completedTasks.json, and plans/archived", () => {
  const root = newRoot();
  initRepo(root);
  mkdirSync(join(root, "plans", "archived"), { recursive: true });
  commitFile(root, "tasks.json", "[]");
  commitFile(root, "completedTasks.json", "[]");
  commitFile(root, "plans/archived/note.md", "old");
  commitFile(root, "keep.txt", "keep\n");
  stageFile(root, "tasks.json", "[1]");
  stageFile(root, "completedTasks.json", "[1]");
  stageFile(root, "plans/archived/note.md", "new");
  stageFile(root, "keep.txt", "changed\n");
  const out = run(root);
  assert.ok(!out.includes("tasks.json"));
  assert.ok(!out.includes("archived/note.md"));
  assert.ok(out.includes("keep.txt"));
});

test("resolves the root and labels correctly when invoked from a nested directory", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  stageFile(root, "a.txt", "two\n");
  const out = run(join(root, "nested", "deeper"));
  const label = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${label} ===\n`));
});

test("includes a submodule's diff once when its pointer was staged, labeled by its relative path, and handles a path with a space", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  const sub = join(root, "sub dir");
  initRepo(sub);
  commitFile(sub, "b.txt", "hello\n");
  execFileSync("git", ["add", "sub dir"], { cwd: root });
  stageFile(sub, "b.txt", "world\n");
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.ok(out.includes(`=== ${rootLabel} ===\n`));
  assert.ok(out.includes("=== sub dir ===\n"));
  assert.equal(out.split("=== sub dir ===").length - 1, 1);
});

test("skips a submodule whose pointer was removed, without erroring, and still prints the parent diff", () => {
  const root = newRoot();
  initRepo(root);
  const sub = join(root, "sub");
  initRepo(sub);
  commitFile(sub, "b.txt", "hello\n");
  execFileSync("git", ["add", "sub"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "add submodule pointer"], { cwd: root });
  execFileSync("git", ["rm", "-q", "--cached", "sub"], { cwd: root });
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${rootLabel} ===\n`));
  assert.ok(!out.includes("=== sub ===\n"));
});

test("does not abort and still prints the parent diff when a staged submodule pointer has no repo on disk", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  execFileSync(
    "git",
    ["update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,ghost"],
    { cwd: root },
  );
  stageFile(root, "a.txt", "two\n");
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${rootLabel} ===\n`));
  assert.ok(!out.includes("=== ghost ===\n"));
});

test("includes a nested submodule's diff, discovered via its parent submodule's own staged pointer, and each repo appears once", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  const sub = join(root, "sub");
  initRepo(sub);
  commitFile(sub, "b.txt", "hello\n");
  const nested = join(sub, "nested");
  initRepo(nested);
  commitFile(nested, "c.txt", "hi\n");
  stageFile(nested, "c.txt", "bye\n");
  execFileSync("git", ["add", "nested"], { cwd: sub });
  execFileSync("git", ["add", "sub"], { cwd: root });
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.equal(out.split(`=== ${rootLabel} ===`).length - 1, 1);
  assert.equal(out.split("=== sub ===").length - 1, 1);
  assert.equal(out.split("=== sub/nested ===").length - 1, 1);
});
