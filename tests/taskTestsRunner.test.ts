import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFailingTests, newFailingTests, judgeSuite } from "../scripts/taskTestsRunner.ts";

test("parseFailingTests reads file/name pairs off a reporter tail", () => {
  const log = [
    "ℹ fail 2",
    "✖ failing tests:",
    "",
    "test at tests/a.test.ts:12:1",
    "✖ boom (1ms)",
    "",
    "test at tests/b.test.ts:5:1",
    "✖ also boom (2.5ms)",
  ].join("\n");
  assert.deepEqual(parseFailingTests(log), [
    { file: "tests/a.test.ts", name: "boom" },
    { file: "tests/b.test.ts", name: "also boom" },
  ]);
});

test("newFailingTests drops a known failure and keeps a new one", () => {
  const failing = [
    { file: "tests/a.test.ts", name: "boom" },
    { file: "tests/b.test.ts", name: "new one" },
  ];
  const known = [{ file: "tests/a.test.ts", name: "boom" }];
  assert.deepEqual(newFailingTests(failing, known), [{ file: "tests/b.test.ts", name: "new one" }]);
});

test("judgeSuite treats a crash with no parsed failures as red, not a vacuous pass", () => {
  assert.equal(judgeSuite(false, [], []), false);
});

test("judgeSuite passes when the suite reported all passing", () => {
  assert.equal(judgeSuite(true, [], []), true);
});

test("judgeSuite passes when every parsed failure is already known", () => {
  const failing = [{ file: "tests/a.test.ts", name: "boom" }];
  assert.equal(judgeSuite(false, failing, []), true);
});

test("judgeSuite fails when a parsed failure is new", () => {
  const failing = [{ file: "tests/a.test.ts", name: "boom" }];
  assert.equal(judgeSuite(false, failing, failing), false);
});
