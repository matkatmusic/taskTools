// Behavioral checks for scripts/runTaskTestsHook.ts. Run: node --test tests/runTaskTestsHook.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/runTaskTestsHook.ts", import.meta.url));

const runHook = (payload: object) => spawnSync("node", [hookPath], { input: JSON.stringify(payload), encoding: "utf8" });

test("test_runTaskTestsHook_staysSilentForEveryOtherSkill", () => {
    // Both hook events fire on every skill, so a hook that answers them all injects noise everywhere.
    const result = runHook({ hook_event_name: "PostToolUse", tool_input: { skill: "read-file", args: "/tmp/x" } });
    assert.equal(result.stdout, "");
});

test("test_runTaskTestsHook_answersTheNamespacedSkillName", () => {
    // Plugin skills reach the hook as taskTools:run-task-tests, so a bare-name match alone never fires.
    const result = runHook({ hook_event_name: "PostToolUse", tool_input: { skill: "taskTools:run-task-tests", args: "35" } });
    assert.match(result.stdout, /expected 5 arguments, got 1/);
});

test("test_runTaskTestsHook_refusesAWrongArgumentCountInsteadOfRunningASuite", () => {
    // A missing projectRoot would otherwise reach runFullSuite as undefined and run the wrong tree.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt: '/run-task-tests "35" "r1" "/wt" "main"' });
    assert.match(result.stdout, /expected 5 arguments, got 4/);
});

test("test_runTaskTestsHook_echoesTheFiringEventName", () => {
    // A hookEventName that disagrees with the firing event gets the whole injection dropped.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt: "/run-task-tests bad" });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});
