import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFailingTests, newFailingTests, judgeSuite, runCommandInProcessGroup, isProcessGroupKillSupported } from "../scripts/taskTestsRunner.ts";

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

test("test_runCommandInProcessGroup_killsTheWholeProcessGroupOnTimeout", async () => {
    // Setup: a command that backgrounds a grandchild and waits on it, so the bug (killing only the direct child) would leave it alive.
    const result = await runCommandInProcessGroup(`sleep 999 & echo "child pid: $!"; wait`, process.cwd(), process.env, 200);
    // Verification: the runner reports a timeout, not a normal exit.
    assert.equal(result.timedOut, true);
    // Verification: the reported child pid's process group holds nothing alive a moment after the kill.
    const childPid = Number(result.output.match(/child pid: (\d+)/)![1]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});

test("test_runCommandInProcessGroup_settlesOnceEvenWhenSpawnItselfFails", async () => {
    // A nonexistent cwd makes the underlying spawn emit "error" instead of ever reaching "close".
    await assert.rejects(runCommandInProcessGroup("true", "/no/such/directory", process.env, 1000));
});

test("test_runCommandInProcessGroup_boundsBufferedOutputForANoisyHangingChild", async () => {
    const result = await runCommandInProcessGroup(
        `while true; do echo "noise noise noise noise noise noise noise noise"; done`, process.cwd(), process.env, 300,
    );
    assert.equal(result.timedOut, true);
    assert.ok(result.output.length <= 8_100, `output length was ${result.output.length}`);
});

test("test_isProcessGroupKillSupported_isFalseOnlyOnWin32", () => {
    assert.equal(isProcessGroupKillSupported("win32"), false);
    assert.equal(isProcessGroupKillSupported("darwin"), true);
    assert.equal(isProcessGroupKillSupported("linux"), true);
});
