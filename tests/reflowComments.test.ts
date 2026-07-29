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
  assert.deepEqual(runs, [{ start: 1, end: 4, line: 1, words: 51, joined: true, capped: true }]);
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

test("a ponytail: note is joined like prose but never flagged for truncation", () => {
  const source = [
    "// Consent gate for the two impure stages (script re-execution and git",
    "// shell-outs). Defaults ON so the CLI and tests behave exactly as before;",
    "// ponytail: process-wide switch, not per-call threading — builds are",
    "// synchronous, thread an options object through if that changes.",
    "let allowed = true;",
  ].join("\n");
  const { text, runs } = reflowSource(source);
  assert.deepEqual(text.split("\n"), [
    "// Consent gate for the two impure stages (script re-execution and git shell-outs). Defaults ON so the CLI and tests behave exactly as before;",
    "// ponytail: process-wide switch, not per-call threading — builds are synchronous, thread an options object through if that changes.",
    "let allowed = true;",
  ]);
  assert.deepEqual(runs.map((r) => [r.line, r.joined, r.capped]), [[1, true, true], [2, true, false]]);

  const payload = JSON.parse(describeReflows([{ path: "/tmp/a.ts", runs }]));
  assert.deepEqual(payload.rewritten, [{ file: "/tmp/a.ts", lines: [1, 2] }]);
  assert.deepEqual(payload.files, [
    { path: "/tmp/a.ts", lines: [1], show: "nl -ba '/tmp/a.ts' | sed -n '1p'" },
  ]);
});

test("a long single-line ponytail: note is not reported at all", () => {
  const flat = `// ponytail: ${Array.from({ length: 25 }, (_, n) => `word${n}`).join(" ")}`;
  const { text, runs } = reflowSource([flat, "const x = 1;"].join("\n"));
  assert.equal(text, [flat, "const x = 1;"].join("\n"));
  assert.deepEqual(runs, []);
});

test("an already-flat comment over the cap is reported but not rewritten", () => {
  const flat = `// ${Array.from({ length: 25 }, (_, n) => `word${n}`).join(" ")}`;
  const { text, runs } = reflowSource([flat, "const x = 1;"].join("\n"));
  assert.equal(text, [flat, "const x = 1;"].join("\n"));
  assert.deepEqual(runs, [{ start: 1, end: 1, line: 1, words: 25, joined: false, capped: true }]);

  const payload = JSON.parse(describeReflows([{ path: "/tmp/a.ts", runs }]));
  assert.equal(payload.rewritten, undefined);
  assert.equal(payload.information, undefined);
  assert.deepEqual(payload.files, [
    { path: "/tmp/a.ts", lines: [1], show: "nl -ba '/tmp/a.ts' | sed -n '1p'" },
  ]);
});

test("a ---- divider ---- is passed through and ends the run above it", () => {
  const source = [
    "  // trailing prose of the",
    "  // previous section",
    "  // ---- task #251: content-driven ruler spacing ----------",
    "  // Any two CONSECUTIVE nodes of one widget are forced",
    "  // at least ROW_PX apart.",
  ].join("\n");
  const { text, runs } = reflowSource(source);
  assert.deepEqual(text.split("\n"), [
    "  // trailing prose of the previous section",
    "  // ---- task #251: content-driven ruler spacing ----------",
    "  // Any two CONSECUTIVE nodes of one widget are forced at least ROW_PX apart.",
  ]);
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.line]), [[1, 2, 1], [4, 5, 3]]);
});

test("a hyphenated word starting with a keyword is prose, not code", () => {
  const source = [
    "// Sole import: the counters module (itself",
    "// import-free), which tallies replay requests here",
    "// class-based and type-safe callers are unaffected",
  ].join("\n");
  const { runs } = reflowSource(source);
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.joined]), [[1, 3, true]]);
});

test("real keyword lines are still detected as code", () => {
  for (const body of ["const x = 1", "return;", "try {", "catch (e) {", "function(a)", "return"]) {
    const { runs } = reflowSource([`// ${body}`, "// second line of the run"].join("\n"));
    assert.deepEqual(runs, [], `expected code: ${body}`);
  }
});

test("prose ending in a semicolon or paren is not mistaken for code", () => {
  const source = ["// Defaults ON so the CLI and tests behave exactly as before;", "// the viewer boots it OFF."].join("\n");
  const { runs } = reflowSource(source);
  assert.deepEqual(runs.map((r) => r.joined), [true]);
});

test("single-line comments, blank lines, and directives are untouched", () => {
  const source = ["// eslint-disable-next-line no-console", "// because reasons", "", "// lone comment"].join("\n");
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});

test("describeReflows reports every rewritten line plus the over-cap ones", () => {
  const runs = [
    { start: 1, end: 2, line: 1, words: 40, joined: true, capped: true },
    { start: 9, end: 10, line: 8, words: 5, joined: true, capped: true },
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
  const runs = [12, 40, 7].map((line) => ({ start: line, end: line + 1, line, words: 30, joined: true, capped: true }));
  const [file] = JSON.parse(describeReflows([{ path: "/a b/c.ts", runs }])).files;
  assert.equal(file.show, "nl -ba '/a b/c.ts' | sed -n '12p;40p;7p'");
});
