// PostToolUse reflow hook: rewrites the edited file in place and reports it. Run: node --test "tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "reflow-comments-post.ts");

function run(toolInput: object): string {
  return execFileSync("node", ["--no-inspect", SCRIPT], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: toolInput }),
    encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  });
}

function fileWith(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "reflow-post-")), "sample.ts");
  writeFileSync(path, contents);
  return path;
}

test("long wrapped comment: rewrites the file and blocks", () => {
  const path = fileWith(["// A wrapped comment that runs well past the twenty word cap once it",
    "// has been joined back together into one single long line of prose here.",
    "const x = 1;"].join("\n"));
  const out = JSON.parse(run({ file_path: path }));
  assert.equal(out.decision, "block");
  assert.deepEqual(JSON.parse(out.reason).files, [
    { path, lines: [1], show: `nl -ba '${path}' | sed -n '1p'` },
  ]);
  assert.equal(readFileSync(path, "utf8").split("\n").length, 2);
});

test("short wrapped comment: reports the rewrite without blocking", () => {
  const path = fileWith(["// a wrapped", "// short note", "const x = 1;"].join("\n"));
  const out = JSON.parse(run({ file_path: path }));
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  const payload = JSON.parse(out.hookSpecificOutput.additionalContext);
  assert.deepEqual(payload.rewritten, [{ file: path, lines: [1] }]);
  assert.equal(payload.files, undefined);
  assert.equal(readFileSync(path, "utf8"), "// a wrapped short note\nconst x = 1;");
});

test("commented-out code and already-flat files stay silent", () => {
  const source = ["// const a = 1;", "// const b = 2;", "// a lone flat comment"].join("\n");
  const path = fileWith(source);
  assert.equal(run({ file_path: path }), "");
  assert.equal(readFileSync(path, "utf8"), source);
});

test("missing path or notebook edit: silent", () => {
  assert.equal(run({ notebook_path: "/nope/x.ipynb" }), "");
  assert.equal(run({ file_path: "/definitely/not/here.ts" }), "");
});
