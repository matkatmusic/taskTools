// Behavioral checks for identityTranslator.ts: run it the way runStepHook's runTranslator does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TRANSLATOR_PATH = fileURLToPath(new URL("./identityTranslator.ts", import.meta.url));

function runTranslator(payload: Record<string, unknown>): unknown {
    const stdout = execFileSync("node", ["--no-inspect", TRANSLATOR_PATH, JSON.stringify(payload)], { encoding: "utf8" });
    return JSON.parse(stdout.trimEnd().split("\n").at(-1)!);
}

test("test_identityTranslator_forwardsAPayloadUnchanged", () => {
    const payload = { box: "PREAMBLE_STATUS_CHECK", scriptSignal: "continue", note: "ok" };
    assert.deepEqual(runTranslator(payload), payload);
});

test("test_identityTranslator_forwardsANestedPayloadUnchanged", () => {
    const payload = { taskNumber: 209, tasksFile: "/tmp/tasks.json", flags: { blocked: false, notes: ["a", "b"] } };
    assert.deepEqual(runTranslator(payload), payload);
});
