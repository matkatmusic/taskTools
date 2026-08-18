// Behavioral checks for scripts/tackle-tasks/MergeWorktreesBodyEmitter.ts. Run: node --test tests/MergeWorktreesBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWorktreesPrompt } from "../scripts/tackle-tasks/MergeWorktreesBodyEmitter.ts";
import type { MergeWorktreesPromptInput } from "../scripts/tackle-tasks/MergeWorktreesBodyEmitter.ts";

const input: MergeWorktreesPromptInput = {
    taskNumber: 169,
    runId: "run-abc",
    projectRoot: "/abs/repo",
    worktree: "/abs/repo/.worktrees/task-169",
    sourceBranch: "master",
};

test("test_mergeWorktreesPrompt_namesBothScriptsByAbsolutePathInOrder", () => {
    const prompt = mergeWorktreesPrompt(input);
    const mergeMatch = prompt.match(/node (\S+) <<'TTMERGE'/);
    const readMatch = prompt.match(/node (\S+) <<'TTREAD'/);
    assert.ok(mergeMatch, "TTMERGE script invocation not found");
    assert.ok(readMatch, "TTREAD script invocation not found");
    assert.ok(mergeMatch[1].startsWith("/"), "merge script path is not absolute");
    assert.ok(mergeMatch[1].endsWith("/mergeTaskWorktree.ts"), "merge script path is not mergeTaskWorktree.ts");
    assert.ok(readMatch[1].startsWith("/"), "read script path is not absolute");
    assert.ok(readMatch[1].endsWith("/readPublicationState.ts"), "read script path is not readPublicationState.ts");
    assert.ok(prompt.indexOf("mergeTaskWorktree.ts") < prompt.indexOf("readPublicationState.ts"));
});

test("test_mergeWorktreesPrompt_bothPayloadsRoundTripThroughTheirHeredocs", () => {
    const prompt = mergeWorktreesPrompt(input);
    const mergeHeredoc = prompt.match(/<<'TTMERGE'\n([\s\S]*?)\nTTMERGE/);
    const readHeredoc = prompt.match(/<<'TTREAD'\n([\s\S]*?)\nTTREAD/);
    assert.ok(mergeHeredoc, "TTMERGE heredoc not found");
    assert.ok(readHeredoc, "TTREAD heredoc not found");
    assert.deepEqual(JSON.parse(mergeHeredoc[1]), {
        projectRoot: input.projectRoot,
        worktreePath: input.worktree,
        taskNumber: input.taskNumber,
        runId: input.runId,
        rootSourceBranch: input.sourceBranch,
    });
    assert.deepEqual(JSON.parse(readHeredoc[1]), {
        taskNumber: input.taskNumber,
        projectRoot: input.projectRoot,
        worktreePath: input.worktree,
    });
});

test("test_mergeWorktreesPrompt_containsNoBacktick", () => {
    assert.doesNotMatch(mergeWorktreesPrompt(input), /`/);
});
