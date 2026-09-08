import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCK_WAIT_DEADLINE_MS } from "../scripts/tackle-tasks/lockSourceRepo/HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
type HookEntry = { hooks: { command: string; timeout?: number }[]; matcher?: string };
const hooksConfig = JSON.parse(readFileSync(`${repoRoot}hooks/hooks.json`, "utf8")) as {
    hooks: { UserPromptSubmit: HookEntry[]; PostToolUse: HookEntry[] };
};

function findRunStepHookTimeout(entries: HookEntry[], matcher?: string): number | undefined {
    const group = entries.find((entry) => entry.matcher === matcher);
    if (group === undefined) throw new Error(`no hooks.json entry with matcher ${JSON.stringify(matcher)}`);
    const runStepHookEntry = group.hooks.find((hook) => hook.command.includes("runStepHook.ts"));
    if (runStepHookEntry === undefined) throw new Error(`no runStepHook.ts command under matcher ${JSON.stringify(matcher)}`);
    return runStepHookEntry.timeout;
}

test("test_hookTimeouts_runStepHookHasAnExplicitTimeoutOnBothRegistrations", () => {
    const userPromptSubmitTimeout = findRunStepHookTimeout(hooksConfig.hooks.UserPromptSubmit, undefined);
    const postToolUseSkillTimeout = findRunStepHookTimeout(hooksConfig.hooks.PostToolUse, "Skill");
    assert.equal(typeof userPromptSubmitTimeout, "number");
    assert.equal(typeof postToolUseSkillTimeout, "number");
});

const STEP_TIMEOUT_MS = 660_000; // scripts/hooks/runStepHook.ts:70, duplicated here so this test has no import cycle on runStepHook.ts.

test("test_hookTimeouts_lockWaitDeadlineLeavesRoomForOneWorstCaseStepUnderTheHookTimeout", () => {
    const userPromptSubmitTimeout = findRunStepHookTimeout(hooksConfig.hooks.UserPromptSubmit, undefined)!;
    const postToolUseSkillTimeout = findRunStepHookTimeout(hooksConfig.hooks.PostToolUse, "Skill")!;
    const worstCaseBeforeLock = STEP_TIMEOUT_MS + LOCK_WAIT_DEADLINE_MS;
    assert.ok(worstCaseBeforeLock < userPromptSubmitTimeout * 1000, `${worstCaseBeforeLock}ms is not below a ${userPromptSubmitTimeout}s hook timeout`);
    assert.ok(worstCaseBeforeLock < postToolUseSkillTimeout * 1000, `${worstCaseBeforeLock}ms is not below a ${postToolUseSkillTimeout}s hook timeout`);
});
