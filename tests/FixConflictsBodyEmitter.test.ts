// Behavioral checks for scripts/tackle-tasks/FixConflictsBodyEmitter.ts. Run: node --test tests/FixConflictsBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixConflictsPrompt } from "../scripts/tackle-tasks/FixConflictsBodyEmitter.ts";

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

// A repository stopped mid-merge on a real unmerged path, so the emitter's git query has something to find.
function makeConflictedRepo(fileName = "thing.ts"): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-conflicts-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, fileName), "one\n");
    git(repo, "add", fileName);
    git(repo, "commit", "--quiet", "-m", "base");
    git(repo, "checkout", "--quiet", "-b", "other");
    writeFileSync(join(repo, fileName), "two\n");
    git(repo, "commit", "--quiet", "-am", "other side");
    git(repo, "checkout", "--quiet", "main");
    writeFileSync(join(repo, fileName), "three\n");
    git(repo, "commit", "--quiet", "-am", "main side");
    try {
        git(repo, "merge", "other");
    } catch {
        // A conflicting merge exits nonzero; that stopped state is exactly the fixture.
    }
    return repo;
}

test("test_fixConflictsPrompt_derivesTheConflictedPathsFromGitNotFromTheCaller", () => {
    // The caller passed an empty list for this box, so the emitter must find the paths itself.
    const repo = makeConflictedRepo("conflicted.ts");
    const prompt = fixConflictsPrompt(repo);
    assert.ok(prompt.includes(`${repo}/conflicted.ts`), "prompt is missing the conflicted path");
});

test("test_fixConflictsPrompt_listsOnlyUnmergedPathsAndNotEveryChangedFile", () => {
    // A dirty-but-merged file is not a conflict, and granting it would widen the edit fence.
    const repo = makeConflictedRepo("conflicted.ts");
    writeFileSync(join(repo, "untouched.ts"), "edited but never conflicted\n");
    const prompt = fixConflictsPrompt(repo);
    assert.equal(prompt.includes("untouched.ts"), false);
});

test("test_fixConflictsPrompt_throwsWhenNoRebaseIsStopped", () => {
    // Running this box with a clean tree is a caller error, not a prompt with an empty list.
    const repo = mkdtempSync(join(tmpdir(), "fix-conflicts-clean-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    assert.throws(() => fixConflictsPrompt(repo), /no unmerged paths/);
});

test("test_fixConflictsPrompt_citesTheOutputTemplateAndCarriesNoDataBlock", () => {
    // The old prompt returned its shape from a trailing DATA block full of ALL_CAPS placeholders.
    const prompt = fixConflictsPrompt(makeConflictedRepo());
    assert.equal(prompt.includes("---- DATA ----"), false);
    assert.equal(/\b(CHECKOUT_PATH|CONFLICTED_PATHS)\b/.test(prompt), false);
    assert.match(prompt, /fix-conflicts-output-template\.json/);
});

test("test_fixConflictsPrompt_forbidsDrivingTheRebaseItself", () => {
    // A later box advances the rebase; an agent that continues it strands the caller.
    assert.match(fixConflictsPrompt(makeConflictedRepo()), /Never run `git rebase --continue` or `git rebase --abort`/);
});
