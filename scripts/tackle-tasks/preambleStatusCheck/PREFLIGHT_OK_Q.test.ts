// PREFLIGHT_OK_Q.ts is "is the environment ok to run in?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/PREFLIGHT_OK_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    checkDiskSpace,
    checkDuplicateHookRegistration,
    checkPlanModeDefault,
    checkScriptPathsInsideRoot,
    main,
} from "./PREFLIGHT_OK_Q.ts";

function packet(projectRoot: string): string {
    return JSON.stringify({
        box: "IS_TASK_ACTIVE_Q", scriptSignal: "continue", taskNumber: 1, runId: "", projectRoot,
        worktree: "", branch: "task-1", docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "PREFLIGHT_OK_Q",
    });
}

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "PREFLIGHT_OK_Q-"));
}

test("test_PREFLIGHT_OK_Q_diskSpaceCheckPassesOnThisMachine", () => {
    const failure = checkDiskSpace(tmpdir());
    assert.equal(failure, null);
});

test("test_PREFLIGHT_OK_Q_planModePassesWhenSettingsFilesAreMissing", () => {
    const root = tempDir();
    assert.equal(checkPlanModeDefault(root), null);
});

test("test_PREFLIGHT_OK_Q_planModeFailsWhenProjectSettingsDefaultToPlan", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
    const failure = checkPlanModeDefault(root);
    assert.match(failure ?? "", /settings\.json/);
});

test("test_PREFLIGHT_OK_Q_duplicateHookRegistrationPassesWhenFilesAreMissing", () => {
    const root = tempDir();
    assert.equal(checkDuplicateHookRegistration(root), null);
});

test("test_PREFLIGHT_OK_Q_duplicateHookRegistrationPassesWhenSameScriptIsOnDifferentEvents", () => {
    const root = tempDir();
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({
        hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "node scripts/foo.ts" }] }],
            Stop: [{ hooks: [{ command: "node scripts/foo.ts" }] }],
        },
    }));
    assert.equal(checkDuplicateHookRegistration(root), null);
});

test("test_PREFLIGHT_OK_Q_duplicateHookRegistrationFailsWhenSameScriptRepeatsOnTheSameEventAndMatcher", () => {
    const root = tempDir();
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({
        hooks: {
            PreToolUse: [{ matcher: "Edit", hooks: [{ command: "node scripts/foo.ts" }, { command: "node scripts/foo.ts" }] }],
        },
    }));
    const failure = checkDuplicateHookRegistration(root);
    assert.match(failure ?? "", /foo\.ts/);
    assert.match(failure ?? "", /PreToolUse/);
    assert.match(failure ?? "", /Edit/);
});

test("test_PREFLIGHT_OK_Q_scriptPathsInsideRootPassesWhenStepsJsonIsMissing", () => {
    const root = tempDir();
    assert.equal(checkScriptPathsInsideRoot(root), null);
});

test("test_PREFLIGHT_OK_Q_scriptPathsInsideRootFailsOnAPathOutsideScripts", () => {
    const root = tempDir();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "steps.json"), JSON.stringify({
        "pipeline-x.mmd": [{ box: "X", script: "../outside/X.ts" }],
    }));
    const failure = checkScriptPathsInsideRoot(root);
    assert.match(failure ?? "", /outside/);
});

test("test_PREFLIGHT_OK_Q_mainRoutesToMarkTaskActiveWhenEverythingPasses", () => {
    const root = tempDir();
    const output = main(packet(root));
    assert.equal(output.next, "MARK_TASK_ACTIVE");
    assert.equal(output.exitType, "");
});

test("test_PREFLIGHT_OK_Q_mainRoutesToReportOnlyExitWhenAPreflightCheckFails", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
    const output = main(packet(root));
    assert.equal(output.next, "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT");
    assert.equal(output.exitType, "preflight-failed");
    assert.match(output.exitNote, /settings\.json/);
});
