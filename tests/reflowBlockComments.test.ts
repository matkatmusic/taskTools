// One test per block comment from plans/layer2-mockup/index.html. Run: node --test "tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reflowSource } from "../scripts/reflowComments.ts";

type Block = { startLine: number; endLine: number; source: string };
const load = (name: string): Block[] =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

const KINDS = [
  { label: "css", blocks: load("css-comment-blocks.json"), open: "/*", close: "*/", markers: /\/\*+|\*\//g },
  { label: "html", blocks: load("html-comment-blocks.json"), open: "<!--", close: "-->", markers: /<!--|-->/g },
];

// Blank separators between paragraphs, ignoring blanks left behind by delimiter-only lines.
const paragraphs = (text: string, markers: RegExp) => {
  const bodies = text.split("\n").map((line) => line.replace(markers, "").trim());
  while (bodies.length > 0 && bodies[0] === "") bodies.shift();
  while (bodies.length > 0 && bodies.at(-1) === "") bodies.pop();
  return bodies.filter((line) => line === "").length;
};

for (const { label, blocks, open, close, markers } of KINDS) {
  const words = (text: string) => text.replace(markers, " ").split(/\s+/).filter(Boolean);

  for (const { startLine, endLine, source } of blocks) {
    const span = endLine > startLine ? `${startLine}-${endLine}` : `${startLine}`;
    const name = `${label} block @${span}`;

    // A block whose first body character opens a tag is commented-out markup, not prose.
    if (/^</.test(source.trimStart().slice(open.length).trimStart())) {
      test(`${name}: commented-out markup keeps its exact bytes`, () => {
        assert.deepEqual(reflowSource(source), { text: source, runs: [] });
      });
      continue;
    }

    test(`${name}: every word survives, in order`, () => {
      assert.deepEqual(words(reflowSource(source).text), words(source));
    });

    test(`${name}: markers stay intact and balanced`, () => {
      const { text } = reflowSource(source);
      assert.equal(text.split(open).length - 1, 1);
      assert.equal(text.split(close).length - 1, 1);
    });

    test(`${name}: paragraph breaks are preserved`, () => {
      assert.equal(paragraphs(reflowSource(source).text, markers), paragraphs(source, markers));
    });

    test(`${name}: delimiters get their own lines, body indented two`, () => {
      const lines = reflowSource(source).text.split("\n");
      const indent = source.match(/^\s*/)![0];
      assert.equal(lines.at(0), `${indent}${open}`);
      assert.equal(lines.at(-1), `${indent}${close}`);
      for (const line of lines.slice(1, -1).filter((l) => l.trim() !== "")) {
        assert.equal(line.match(/^\s*/)![0], `${indent}  `);
      }
    });

    test(`${name}: each paragraph collapses to one line`, () => {
      const bodyLines = reflowSource(source).text.split("\n").filter((line) => line.trim() !== "");
      assert.equal(bodyLines.length, paragraphs(source, markers) + 3);
    });

    test(`${name}: reflowing twice changes nothing`, () => {
      const once = reflowSource(source).text;
      assert.equal(reflowSource(once).text, once);
    });

    test(`${name}: nothing is reported as joined on a second pass`, () => {
      const once = reflowSource(source).text;
      assert.deepEqual(reflowSource(once).runs.filter((run) => run.joined), []);
    });
  }
}

test("commented-out CSS inside a block is left alone", () => {
  const source = ["  /* .bubble {", "       color: red;", "     } */"].join("\n");
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});

test("a JSDoc-style block is left alone", () => {
  const source = ["/**", " * Does a thing that wraps", " * across two lines.", " */"].join("\n");
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});

test("commented-out markup inside an HTML comment is left alone", () => {
  const source = ['  <!-- <div class="x">', "         <span>hi</span>", "       </div> -->"].join("\n");
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});

test("a one-line commented-out element keeps its exact bytes", () => {
  const source = '  <!-- <button id="load">Load</button> -->';
  assert.deepEqual(reflowSource(source), { text: source, runs: [] });
});
