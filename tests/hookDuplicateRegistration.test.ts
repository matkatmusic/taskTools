// Regression test for the double-hook-firing bug fixed in commit 72deb79.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDuplicateHookRegistration } from "../scripts/tackle-tasks/preambleStatusCheck/PREFLIGHT_OK_Q.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeTempRoot(): string {
    return mkdtempSync(join(tmpdir(), "hook-duplicate-registration-"));
}

function writeHooksJson(root: string, relativePath: string, hooks: Record<string, unknown>): void {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks }));
}

test("test_checkDuplicateHookRegistration_returnsNullForTheRealRepoRoot", () => {
    assert.equal(checkDuplicateHookRegistration(REPO_ROOT), null);
});

test("test_checkDuplicateHookRegistration_namesTheScriptAndEventWhenSettingsReRegistersAHooksJsonScript", () => {
    const root = makeTempRoot();
    writeHooksJson(root, "hooks/hooks.json", {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node runStepHook.ts" }] }],
    });
    writeHooksJson(root, ".claude/settings.json", {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node runStepHook.ts" }] }],
    });

    const result = checkDuplicateHookRegistration(root);

    assert.match(result ?? "", /runStepHook\.ts/);
    assert.match(result ?? "", /UserPromptSubmit/);
});

test("test_checkDuplicateHookRegistration_returnsNullWhenTheSameScriptIsOnDifferentEventsOrMatchers", () => {
    const root = makeTempRoot();
    writeHooksJson(root, "hooks/hooks.json", {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node runStepHook.ts" }] }],
    });
    writeHooksJson(root, ".claude/settings.json", {
        PostToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: "node runStepHook.ts" }] }],
    });

    assert.equal(checkDuplicateHookRegistration(root), null);
});
