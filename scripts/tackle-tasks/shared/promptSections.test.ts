// Behavioral checks for scripts/tackle-tasks/promptSections.ts. Run: node --test tests/promptSections.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { absolutePathsSection } from "./promptSections.ts";
import { fixConflictsPrompt } from "./FixConflictsBodyEmitter.ts";
import { planPrompt } from "./planPrompt.ts";
import type { PreparedTask } from "./preparedTask.ts";
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
    readOnlyFiles: ["*"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    readFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    createsFiles: [],
    difficulty: 1,
    clarifyRequest: "",
    testFilePaths: [],
    hasTests: true,
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    siblingTasks: [],
    blockedBy: [],
    blocks: [],
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

test("test_absolutePathsSection_namesTheRootInEveryRuleThatNeedsIt", () => {
    // A section that omits the root cannot warn about the ambient checkout it shadows.
    const section = absolutePathsSection("/tmp/SENTINEL_ROOT_ps1");
    assert.match(section, /^## ALWAYS USE ABSOLUTE PATHS\n/);
    assert.equal(section.split("/tmp/SENTINEL_ROOT_ps1").length, 3);
});

// planPrompt and fixConflictsPrompt still call this shared section; IMPLEMENT_TASK and FIX_THE_CODEBASE_FOR_SUITE build prompts independently.
test("test_everyPromptUsesTheSharedAbsolutePathsSectionVerbatim", () => {
    const repo = makeConflictedRepo();
    const prompts = [planPrompt(fakeTask), fixConflictsPrompt(repo, 99, "/tmp/fake-project-root", "run-1", "main")];
    const roots = [fakeTask.repoRoot, repo];
    prompts.forEach((prompt, index) => {
        assert.ok(prompt.includes(absolutePathsSection(roots[index])), `prompt ${index} does not carry the shared section`);
    });
});
