// Behavioral checks for scripts/tackle-tasks/RebaseWorktreeBodyEmitter.ts. Run: node --test tests/RebaseWorktreeBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { rebaseWorktreePrompt } from "../scripts/tackle-tasks/RebaseWorktreeBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";

const task: PreparedTask = {
    number: 35, briefFile: "/wt/plans/brief-35.md", planFile: "/wt/plans/plan.json",
    reviewFile: "/wt/plans/codex-review.json", reviewOutputFile: "/wt/plans/codex-review.json",
    testReviewFile: "/wt/plans/test-review.json", notesFile: "/wt/plans/implementation-notes-35.md",
    files: ["src/owned.ts"], ownedFilePaths: ["/wt/src/owned.ts"], testFilePaths: [],
    tests: null, codexReviewNotes: "", repoRoot: "/wt", taskStateRoot: "/project",
};

test("test_rebaseWorktreePrompt_passesEveryHookArgumentQuotedAndInOrder", () => {
    // The hook refuses any count but five, and a worktree path with spaces needs the quotes.
    const prompt = rebaseWorktreePrompt(task, "r1", "main");
    assert.match(prompt, /\/rebase-worktree "35" "r1" "\/wt" "main" "\/project"/);
});

test("test_rebaseWorktreePrompt_leavesTheVerdictToTheSkillAndAsksForItVerbatim", () => {
    // This box derives nothing in prose; the skill decides, the agent relays.
    const prompt = rebaseWorktreePrompt(task, "r1", "main");
    assert.match(prompt, /Return the skill's output verbatim\./);
    assert.equal(prompt.includes("---- DATA ----"), false);
});
