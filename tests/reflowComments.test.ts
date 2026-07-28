// reflowComments joins wrapped prose, skips commented-out code. Run: node --test "tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeReflows, reflowSource } from "../scripts/reflowComments.ts";

const WRAPPED = [
  "// Nothing to say unless one of those files still has unstaged work. A porcelain",
  "// line's second column is the worktree status: space means staged-and-clean,",
  '// anything else (including "??") means the user still has staging to do.',
  "// Paths outside a git repo throw and count as clean — nothing to stage there.",
].join("\n");

const JOINED =
  "// Nothing to say unless one of those files still has unstaged work. A porcelain" +
  " line's second column is the worktree status: space means staged-and-clean," +
  ' anything else (including "??") means the user still has staging to do.' +
  "  Paths outside a git repo throw and count as clean — nothing to stage there.";

const COMMENTED_CODE = [
  "// process.stdout.write(JSON.stringify({",
  "//   hookSpecificOutput: {",
  '//     hookEventName: "Stop",',
  "//     additionalContext: `read ${instructionsPath}`,",
  "//   },",
  "// }));",
].join("\n");

test("wrapped prose collapses to one line, two spaces after a sentence", () => {
  const { text, runs } = reflowSource(WRAPPED);
  assert.equal(text, JOINED);
  assert.deepEqual(runs, [{ start: 1, end: 4, line: 1, words: 51 }]);
});

test("commented-out code is left exactly as written", () => {
  const { text, runs } = reflowSource(COMMENTED_CODE);
  assert.equal(text, COMMENTED_CODE);
  assert.deepEqual(runs, []);
});

test("surrounding code and indentation survive, runs report shifted line numbers", () => {
  const source = [
    "const a = 1;",
    "  // a short wrapped",
    "  // comment here",
    "const b = 2;",
    "// second run that",
    "// also wraps",
  ].join("\n");
  const { text, runs } = reflowSource(source);
  assert.equal(
    text,
    ["const a = 1;", "  // a short wrapped comment here", "const b = 2;", "// second run that also wraps"].join("\n"),
  );
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.line]), [[2, 3, 2], [5, 6, 4]]);
});

test("single-line comments, blank lines, and directives are untouched", () => {
  const source = ["// eslint-disable-next-line no-console", "// because reasons", "", "// lone comment"].join("\n");
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});

test("all-short reflows omit the truncation sentence", () => {
  const short = reflowSource(["// a wrapped", "// short note"].join("\n"));
  assert.deepEqual(describeReflows([{ path: "f.ts", runs: short.runs }]), {
    text: "f.ts\nThe comments on lines [1] were each rewritten as a single line.",
    needsRewrite: false,
  });
});

test("each file lists every reflow, then only the lines over the word cap", () => {
  const long = reflowSource(WRAPPED).runs;
  const short = reflowSource(["// a wrapped", "// short note"].join("\n")).runs;
  const { text, needsRewrite } = describeReflows([
    { path: "a.ts", runs: [...long, ...short.map((r) => ({ ...r, line: 9 }))] },
    { path: "b.ts", runs: short },
  ]);
  assert.equal(needsRewrite, true);
  assert.deepEqual(text.split("\n"), [
    "a.ts",
    "The comments on lines [1, 9] were each rewritten as a single line.",
    "the comments on lines [1] need to be truncated to be less than 20 words long. rewrite the comments.",
    "b.ts",
    "The comments on lines [1] were each rewritten as a single line.",
  ]);
});
