// Behavioral checks for scripts/tackle-tasks/promptSections.ts. Run: node --test tests/promptSections.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { absolutePathsSection } from "../scripts/tackle-tasks/promptSections.ts";
import { fixConflictsPrompt } from "../scripts/tackle-tasks/FixConflictsBodyEmitter.ts";
import { implementPrompt } from "../scripts/tackle-tasks/ImplementBodyEmitter.ts";
import { planPrompt } from "../scripts/tackle-tasks/PlannerBodyEmitter.ts";
import { suiteFixPrompt } from "../scripts/tackle-tasks/SuiteFixBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeTask: PreparedTask = {
    number: 99,
    briefFile: "/tmp/fake-worktree/plans/brief-99.md",
    planFile: "/tmp/fake-worktree/plans/plan.json",
    reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
    reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
    testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
    notesFile: "/tmp/fake-worktree/plans/implementation-notes-99.md",
    files: ["src/thing.ts"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    testFilePaths: [],
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

// A repository stopped mid-merge, because fix-conflicts derives its file list from git.
function makeConflictedRepo(): string {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    const repo = mkdtempSync(join(tmpdir(), "prompt-sections-"));
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "thing.ts"), "one\n");
    git("add", "thing.ts");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "other");
    writeFileSync(join(repo, "thing.ts"), "two\n");
    git("commit", "--quiet", "-am", "other side");
    git("checkout", "--quiet", "main");
    writeFileSync(join(repo, "thing.ts"), "three\n");
    git("commit", "--quiet", "-am", "main side");
    try {
        git("merge", "other");
    } catch {
        // A conflicting merge exits nonzero; that stopped state is exactly the fixture.
    }
    return repo;
}

// A project root recording one red suite, because fix-suite derives its failing output from state.
function makeRedSuiteRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "prompt-sections-suite-"));
    const run = {
        runId: "r1", startedAt: "2026-08-18T00:00:00", endedAt: null, exitType: null, exitNote: null,
        modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null,
        fullSuite: { stepId: "run the full suite", layers: [{ occurrenceId: "", passed: false }], passed: false, output: "1 failing", checkedAt: "2026-08-18T00:00:00" },
    };
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 99, files: ["src/thing.ts"],
        run: { active: true, worktree: null, leaseRunId: null, history: [run] },
    }]));
    return root;
}

test("test_absolutePathsSection_namesTheRootInEveryRuleThatNeedsIt", () => {
    // A section that omits the root cannot warn about the ambient checkout it shadows.
    const section = absolutePathsSection("/tmp/SENTINEL_ROOT_ps1");
    assert.match(section, /^## ALWAYS USE ABSOLUTE PATHS\n/);
    assert.equal(section.split("/tmp/SENTINEL_ROOT_ps1").length, 3);
});

test("test_everyPromptUsesTheSharedAbsolutePathsSectionVerbatim", () => {
    // Three prompts had three wordings; a copy that drifts is the thing this element prevents.
    const repo = makeConflictedRepo();
    const prompts = [
        planPrompt(fakeTask),
        implementPrompt(fakeTask, "", "npx tsc --noEmit", 3),
        fixConflictsPrompt(repo),
        suiteFixPrompt({ ...fakeTask, taskStateRoot: makeRedSuiteRoot() }),
    ];
    const roots = [fakeTask.repoRoot, fakeTask.repoRoot, repo, fakeTask.repoRoot];
    prompts.forEach((prompt, index) => {
        assert.ok(prompt.includes(absolutePathsSection(roots[index])), `prompt ${index} does not carry the shared section`);
    });
});
