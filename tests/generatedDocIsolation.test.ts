// Behavioral check for the repository .gitignore hiding generated pipeline docs. Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

test("test_gitignore_hidesANewlyCreatedPlanJsonFromGitStatus", () => {
    // Setup: a real temp git repo carrying a copy of this repository's own .gitignore.
    const repoRoot = mkdtempSync(join(tmpdir(), "gitignore-plan-json-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    copyFileSync(join(import.meta.dirname, "..", ".gitignore"), join(repoRoot, ".gitignore"));
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    writeFileSync(join(repoRoot, "plans", "task-1-plan.md"), "tracked plan\n");
    git(repoRoot, "add", ".gitignore", "plans/task-1-plan.md");
    git(repoRoot, "commit", "-q", "-m", "seed");

    // Test action: create a new, untracked plans/plan.json inside that repo.
    writeFileSync(join(repoRoot, "plans", "plan.json"), "{}\n");
    const status = git(repoRoot, "status", "--porcelain");

    // Verification: git status does not list the generated plan.json.
    assert.doesNotMatch(status, /plan\.json/);
});
