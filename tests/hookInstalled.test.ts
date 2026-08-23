// Confirms the run-step hook is registered on both events, in settings.json now and hooks.json once packaged.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = [".claude/settings.json", "hooks/hooks.json"];

function isRegistered(event: string, matcher?: string) {
    return FILES
        .filter(file => existsSync(join(ROOT, file)))
        .map(file => JSON.parse(readFileSync(join(ROOT, file), "utf8")))
        .flatMap(config => config.hooks?.[event] ?? [])
        .filter(group => group.matcher === matcher)
        .flatMap(group => group.hooks ?? [])
        .some(hook => hook.type === "command" && hook.command.includes("runStepHook.ts"));
}

test("test_runStepHook_isRegisteredOnUserPromptSubmit", () => {
    assert.ok(isRegistered("UserPromptSubmit"), `no UserPromptSubmit command runs runStepHook.ts in ${FILES.join(" or ")}`);
});

test("test_runStepHook_isRegisteredOnPostToolUseSkill", () => {
    assert.ok(isRegistered("PostToolUse", "Skill"), `no PostToolUse:Skill command runs runStepHook.ts in ${FILES.join(" or ")}`);
});
