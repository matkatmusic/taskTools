// Behavioral checks for scripts/tackle-tasks/AgentPromptEmitter.ts. Run: node --test tests/tackle-tasks/AgentPromptEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    amendTestsPrompt,
    codexReviewInstructions,
    fixConflictsPrompt,
    fixSuitePrompt,
    fixTestsPrompt,
    implementPrompt,
    loadPreparedTask,
    planPrompt,
    reviewPlanPrompt,
    reviewTestsPrompt,
    type PreparedTask,
} from "../../scripts/tackle-tasks/AgentPromptEmitter.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/AgentPromptEmitter.ts", import.meta.url));

// Sets up a project root with a task record and a worktree AgentPromptEmitter can write briefs into.
function makeFixture(taskNumber = 42): { projectRoot: string; worktree: string; task: PreparedTask } {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-prompt-emitter-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([
        { taskNumber, title: "sample task", files: ["src/thing.ts"], tests: "node --test tests/thing.test.ts" },
    ]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    const worktree = projectRoot;
    const task = loadPreparedTask(taskNumber, worktree, projectRoot);
    return { projectRoot, worktree, task };
}

// Every eight-role prompt, built from one shared fixture, for tests that check a property over all of them.
function allRolePrompts(task: PreparedTask): Record<string, string> {
    return {
        plan: planPrompt(task),
        "review-plan": reviewPlanPrompt(task),
        implement: implementPrompt(task, "", "npx tsc --noEmit", 3),
        "fix-conflicts": fixConflictsPrompt("/repo", ["src/thing.ts"]),
        "fix-suite": fixSuitePrompt("/repo", "", "1 failing", []),
        "fix-tests": fixTestsPrompt("/repo", "", "1 failing", [], task.number),
        "review-tests": reviewTestsPrompt(task),
        "amend-tests": amendTestsPrompt(task, "notes", ["tests/created.test.ts"], ["tests/foreign.test.ts"]),
    };
}

test("test_agentPromptEmitter_exitsNonZeroOnAnUnknownRole", () => {
    // Setup: a fixture with a valid task, but a role name no handler recognizes.
    const { projectRoot, worktree } = makeFixture();
    const payload = JSON.stringify({ worktree, projectRoot, sourceBranch: "main", runId: "run-1" });

    // Test action: run the CLI directly with role "not-a-real-role".
    const result = spawnSync("node", [cliPath, "42", "not-a-real-role"], { input: payload, encoding: "utf8" });

    // Verification: the process exits non-zero rather than printing a prompt.
    assert.notEqual(result.status, 0);
});

test("test_agentPromptEmitter_emitsTheSameCodexFallbackChainForBothReviewRoles", () => {
    // Setup: two different review questions routed through the one shared helper.
    const planReview = codexReviewInstructions("review the plan", "the plan", 1);
    const testsReview = codexReviewInstructions("review the tests", "the tests", 1);

    // Verification: the fallback commands and their surrounding rules are identical in shape,
    // independent of the embedded question text.
    for (const chain of [planReview, testsReview]) {
        assert.match(chain, /codex exec -s read-only/);
        assert.match(chain, /claude -p .* --tools "Read" --model fable --effort medium/);
        assert.match(chain, /claude -p .* --tools "Read" --model claude-opus-4-8 --effort high/);
        assert.match(chain, /Never report a fallback review as codex\./);
    }
});

test("test_fixSuitePrompt_forbidsEditingTests", () => {
    const prompt = fixSuitePrompt("/repo", "", "1 failing", []);
    assert.match(prompt, /never the test itself/);
    assert.match(prompt, /forbidden.*to edit a test file at all/s);
});

test("test_fixTestsPrompt_forbidsEditingTests", () => {
    const prompt = fixTestsPrompt("/repo", "", "1 failing", [], 42);
    assert.match(prompt, /never the test itself/);
    assert.match(prompt, /forbidden.*to edit a test file at all/s);
});

test("test_noPromptContainsAGitCommand", () => {
    // Setup: every role's prompt, from a single fixture.
    const { task } = makeFixture(43);
    const prompts = allRolePrompts(task);

    // One regex catches every actual git-invocation shape v1_1 used to run: `git -C`, `git add`,
    // `git commit`, etc. Rule 1 says the commit box owns committing, so none may survive here.
    // A prose mention naming a git subcommand only to forbid running it (kept verbatim per the
    // plan's mapping table, e.g. "do not run `git rebase --continue`") never matches this shape.
    const gitCommandPattern = /\bgit\s+(-C\b|add\b|commit\b|push\b|checkout\b|reset\b|merge\b|rm\b)/;

    for (const [role, prompt] of Object.entries(prompts)) {
        assert.equal(gitCommandPattern.test(prompt), false, `role "${role}" contains a git command`);
    }
});

test("test_amendTestsPrompt_distinguishesCreatedTestsFromModifiedForeignOnes", () => {
    const { task } = makeFixture(44);
    const prompt = amendTestsPrompt(task, "fix it", ["tests/created.test.ts"], ["tests/foreign.test.ts"]);

    // Created tests are freely editable; the foreign one only under the broken-or-empty exception.
    assert.match(prompt, /freely edit:\n {2}- tests\/created\.test\.ts/);
    assert.match(prompt, /broken\n?or asserts nothing applies to every one of these.*\n {2}- tests\/foreign\.test\.ts/s);
});

test("test_planPrompt_includesTheScrapNotesWhenAPreambleIsGiven", () => {
    const { task } = makeFixture(45);
    const preamble = "Codex scrapped the previous plan because step-2 was vague.\n\n";

    const prompt = planPrompt(task, preamble);

    assert.match(prompt, /Codex scrapped the previous plan because step-2 was vague\./);
});

test("test_reviewTestsPrompt_forbidsRunningTheTests", () => {
    const { task } = makeFixture(46);
    const prompt = reviewTestsPrompt(task);
    assert.match(prompt, /never run the tests/i);
});

for (const [role, buildPrompt] of Object.entries({
    plan: (task: PreparedTask) => planPrompt(task),
    "review-plan": (task: PreparedTask) => reviewPlanPrompt(task),
    implement: (task: PreparedTask) => implementPrompt(task, "a note", "npx tsc --noEmit", 3),
    "fix-conflicts": () => fixConflictsPrompt("/repo", ["src/thing.ts"]),
    "fix-suite": () => fixSuitePrompt("/repo", "root-layer", "1 failing", ["vendor"]),
    "fix-tests": (task: PreparedTask) => fixTestsPrompt("/repo", "root-layer", "1 failing", ["vendor"], task.number),
    "review-tests": (task: PreparedTask) => reviewTestsPrompt(task),
    "amend-tests": (task: PreparedTask) => amendTestsPrompt(task, "notes", ["tests/created.test.ts"], ["tests/foreign.test.ts"]),
})) {
    test(`test_${role.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Prompt_leavesNoUnresolvedInterpolation`, () => {
        const { task } = makeFixture();
        const prompt = buildPrompt(task);
        assert.equal(prompt.includes("${"), false);
        assert.equal(prompt.includes("$ARGUMENTS"), false);
    });
}
