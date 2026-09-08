// Behavioral checks for scripts/tackle-tasks/FinishRunBodyEmitter.ts. Run: node --test tests/FinishRunBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishRunPrompt } from "../scripts/tackle-tasks/FinishRunBodyEmitter.ts";
import type { FinishRunPromptInput } from "../scripts/tackle-tasks/FinishRunBodyEmitter.ts";

const input: FinishRunPromptInput = {
    taskNumber: 169,
    runId: "run-abc",
    projectRoot: "/abs/repo",
    worktree: "/abs/repo/.worktrees/task-169",
    sourceBranch: "master",
    exitType: "mergeSucceeded",
    exitNote: "landed clean",
};

test("test_finishRunPrompt_namesTheScriptByAbsolutePath", () => {
    const prompt = finishRunPrompt(input);
    const match = prompt.match(/node (\S+) <<'TTFINISH'/);
    assert.ok(match, "script invocation not found");
    assert.ok(match[1].startsWith("/"), "script path is not absolute");
    assert.ok(match[1].endsWith("/finishTaskRun.ts"), "script path is not finishTaskRun.ts");
});

test("test_finishRunPrompt_payloadRoundTripsThroughTheHeredoc", () => {
    const prompt = finishRunPrompt(input);
    const heredoc = prompt.match(/<<'TTFINISH'\n([\s\S]*?)\nTTFINISH/);
    assert.ok(heredoc, "TTFINISH heredoc not found");
    assert.deepEqual(JSON.parse(heredoc[1]), { ...input, boxId: "finishTaskRun" });
});

test("test_finishRunPrompt_containsNoBacktick", () => {
    assert.doesNotMatch(finishRunPrompt(input), /`/);
});
