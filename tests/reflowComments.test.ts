// reflowComments joins wrapped prose, skips commented-out code. Run: node --test "tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeReflows, needsRewrite, reflowSource } from "../scripts/reflowComments.ts";

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

test("a bare // splits paragraphs instead of rejecting the whole block", () => {
  const source = [
    "// first paragraph that",
    "// wraps across two lines",
    "//",
    "// second paragraph that",
    "// also wraps",
    "const x = 1;",
  ].join("\n");
  const { text, runs } = reflowSource(source);
  assert.deepEqual(text.split("\n"), [
    "// first paragraph that wraps across two lines",
    "//",
    "// second paragraph that also wraps",
    "const x = 1;",
  ]);
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.line]), [[1, 2, 1], [4, 5, 3]]);
});

test("a bare // between single-line comments joins nothing", () => {
  const source = ["// alone", "//", "// also alone"].join("\n");
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});

test("single-line comments, blank lines, and directives are untouched", () => {
  const source = ["// eslint-disable-next-line no-console", "// because reasons", "", "// lone comment"].join("\n");
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});

test("describeReflows reports every rewritten line plus the over-cap ones", () => {
  const runs = [
    { start: 1, end: 2, line: 1, words: 40 },
    { start: 9, end: 10, line: 8, words: 5 },
  ];
  const payload = JSON.parse(describeReflows([{ path: "/tmp/a.ts", runs }]));
  assert.equal(payload.information, "the following lines were rewritten by a hook after your edit");
  assert.deepEqual(payload.rewritten, [{ file: "/tmp/a.ts", lines: [1, 8] }]);
  assert.match(payload.instruction, /under 20 words/);
  assert.deepEqual(payload.files, [
    { path: "/tmp/a.ts", lines: [1], show: "nl -ba '/tmp/a.ts' | sed -n '1p'" },
  ]);
});

test("all-short reflows report the rewrite but carry no instruction", () => {
  const runs = reflowSource(["// a wrapped", "// short note"].join("\n")).runs;
  const payload = JSON.parse(describeReflows([{ path: "/tmp/a.ts", runs }]));
  assert.deepEqual(payload.rewritten, [{ file: "/tmp/a.ts", lines: [1] }]);
  assert.equal(payload.instruction, undefined);
  assert.equal(payload.files, undefined);
  assert.equal(needsRewrite([{ path: "/tmp/a.ts", runs }]), false);
});

test("the show command lists every over-cap line in order", () => {
  const runs = [12, 40, 7].map((line) => ({ start: line, end: line + 1, line, words: 30 }));
  const [file] = JSON.parse(describeReflows([{ path: "/a b/c.ts", runs }])).files;
  assert.equal(file.show, "nl -ba '/a b/c.ts' | sed -n '12p;40p;7p'");
});
