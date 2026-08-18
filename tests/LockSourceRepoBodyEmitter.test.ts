// Behavioral checks for scripts/tackle-tasks/LockSourceRepoBodyEmitter.ts. Run: node --test tests/LockSourceRepoBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockSourceRepoPrompt } from "../scripts/tackle-tasks/LockSourceRepoBodyEmitter.ts";
import type { LockSourceRepoPromptInput } from "../scripts/tackle-tasks/LockSourceRepoBodyEmitter.ts";

const input: LockSourceRepoPromptInput = {
    taskNumber: 169,
    runId: "run-abc",
    projectRoot: "/abs/repo",
};

test("test_lockSourceRepoPrompt_namesTheScriptByAbsolutePath", () => {
    const prompt = lockSourceRepoPrompt(input);
    const match = prompt.match(/node (\S+) <<'TTLOCK'/);
    assert.ok(match, "script invocation not found");
    assert.ok(match[1].startsWith("/"), "script path is not absolute");
    assert.ok(match[1].endsWith("/lockSourceRepo.ts"), "script path is not lockSourceRepo.ts");
});

test("test_lockSourceRepoPrompt_payloadRoundTripsThroughTheHeredoc", () => {
    const prompt = lockSourceRepoPrompt(input);
    const heredoc = prompt.match(/<<'TTLOCK'\n([\s\S]*?)\nTTLOCK/);
    assert.ok(heredoc, "TTLOCK heredoc not found");
    assert.deepEqual(JSON.parse(heredoc[1]), input);
});

test("test_lockSourceRepoPrompt_containsNoBacktick", () => {
    assert.doesNotMatch(lockSourceRepoPrompt(input), /`/);
});
