// Regression test for the 10s step timeout fixed in commit d146b3b (raised to 300_000ms).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_STEP_HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "hooks", "runStepHook.ts");

test("test_runStepHook_stepTimeoutMsIsAtLeast300000", () => {
    const source = readFileSync(RUN_STEP_HOOK_PATH, "utf8");
    const match = source.match(/const STEP_TIMEOUT_MS = (\d[\d_]*);/);
    assert.notEqual(match, null);
    const value = Number(match![1]!.replace(/_/g, ""));
    assert.ok(value >= 300_000, `STEP_TIMEOUT_MS was ${value}, expected at least 300000`);
});
