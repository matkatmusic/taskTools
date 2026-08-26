// Behavioral checks for scripts/tackle-tasks/CheckFenceBodyEmitter.ts. Run: node --test tests/CheckFenceBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFencePrompt } from "../scripts/tackle-tasks/CheckFenceBodyEmitter.ts";
import type { CheckFencePromptInput } from "../scripts/tackle-tasks/CheckFenceBodyEmitter.ts";

const input: CheckFencePromptInput = {
    taskNumber: 169,
    runId: "run-abc",
    projectRoot: "/abs/repo",
    worktree: "/abs/repo/.worktrees/task-169",
    sourceBranch: "master",
};

test("test_checkFencePrompt_namesTheScriptByAbsolutePath", () => {
    const prompt = checkFencePrompt(input);
    const match = prompt.match(/node (\S+) <<'TTFENCE'/);
    assert.ok(match, "script invocation not found");
    assert.ok(match[1].startsWith("/"), "script path is not absolute");
    assert.ok(match[1].endsWith("/checkTaskFileFence.ts"), "script path is not checkTaskFileFence.ts");
});

test("test_checkFencePrompt_payloadRoundTripsThroughTheHeredoc", () => {
    const prompt = checkFencePrompt(input);
    const heredoc = prompt.match(/<<'TTFENCE'\n([\s\S]*?)\nTTFENCE/);
    assert.ok(heredoc, "TTFENCE heredoc not found");
    assert.deepEqual(JSON.parse(heredoc[1]), {
        projectRoot: input.projectRoot,
        worktreePath: input.worktree,
        taskNumber: input.taskNumber,
        runId: input.runId,
        rootSourceBranch: input.sourceBranch,
        boxId: "DID_CHANGES_STAY_INSIDE_FENCE",
    });
});

test("test_checkFencePrompt_containsNoBacktick", () => {
    assert.doesNotMatch(checkFencePrompt(input), /`/);
});
