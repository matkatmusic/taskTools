// Behavioral checks for scripts/continueRebaseHook.ts. Run: node --test tests/continueRebaseHook.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/continueRebaseHook.ts", import.meta.url));

const runHook = (payload: object) => spawnSync("node", [hookPath], { input: JSON.stringify(payload), encoding: "utf8" });

test("test_continueRebaseHook_staysSilentForEveryOtherSkill", () => {
    // Both hook events fire on every skill, so a hook that answers them all injects noise everywhere.
    const result = runHook({ hook_event_name: "PostToolUse", tool_input: { skill: "read-file", args: "/tmp/x" } });
    assert.equal(result.stdout, "");
});

test("test_continueRebaseHook_answersTheNamespacedSkillName", () => {
    // Plugin skills reach the hook as taskTools:continue-rebase, so a bare-name match alone never fires.
    const result = runHook({ hook_event_name: "PostToolUse", tool_input: { skill: "taskTools:continue-rebase", args: "35" } });
    assert.match(result.stdout, /expected 5 arguments, got 1/);
});

test("test_continueRebaseHook_refusesAWrongArgumentCountInsteadOfRunningASuite", () => {
    // A missing projectRoot would otherwise reach runFullSuite as undefined and run the wrong tree.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt: '/continue-rebase "35" "r1" "/wt" "main"' });
    assert.match(result.stdout, /expected 5 arguments, got 4/);
});

test("test_continueRebaseHook_echoesTheFiringEventName", () => {
    // A hookEventName that disagrees with the firing event gets the whole injection dropped.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt: "/continue-rebase bad" });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});
