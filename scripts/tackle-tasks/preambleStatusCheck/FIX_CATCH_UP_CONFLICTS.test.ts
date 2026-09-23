// Real-git tests for B_FIX_CATCH_UP_CONFLICTS: the prompt names the unmerged paths, and a lost lock or a clean worktree throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./FIX_CATCH_UP_CONFLICTS.ts";
import { buildPromptOutputTemplate } from "../../shared/contracts.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

// A committed repo on "main", so the source-repo lock has a real .git folder to live in.
function makeSourceRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-catch-up-source-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "root");
    return repo;
}

// A repository stopped mid-merge on a real unmerged path, like the task-N-catchUpMerge worktree after a conflict.
function makeConflictedRepo(fileName: string): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-catch-up-worktree-"));
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
    assert.throws(() => git(repo, "merge", "--quiet", "other"));
    return repo;
}

// runId is "" before B_MARK_TASK_ACTIVE, so the catch-up lock owner is ":<taskNumber>".
const inputFor = (projectRoot: string, worktreePath: string, taskNumber: number): string => JSON.stringify({
    box: "Q_CATCH_UP_STAGING",
    scriptSignal: "continue",
    taskNumber,
    runId: "",
    projectRoot,
    worktree: "",
    branch: `task-${taskNumber}`,
    docsMode: "",
    planFile: "",
    exitType: "",
    exitNote: "",
    repository: projectRoot,
    worktreePath,
});

test("test_fixCatchUpConflicts_printsAPromptNamingTheConflictedPathFromTheWorktree", () => {
    // Setup: the merge worktree is stopped on conflicted.ts, and this run holds the source-repo lock.
    const projectRoot = makeSourceRepo();
    const worktreePath = makeConflictedRepo("conflicted.ts");
    assert.equal(acquireSourceRepoLock(projectRoot, buildLockOwner("", 1)).status, "acquired");

    // Test action: run the block.
    const output = main(inputFor(projectRoot, worktreePath, 1));

    // Verification: the block hands a prompt to the agent, and the prompt file names the conflicted path.
    assert.equal(output.box, "B_FIX_CATCH_UP_CONFLICTS");
    assert.equal(output.scriptSignal, "prompt");
    assert.deepEqual(getTemplateShapeMismatches(buildPromptOutputTemplate("FIX_CATCH_UP_CONFLICTS"), output), []);
    assert.doesNotMatch(String(output.prompt), /\/run-step|invoke the skill/i);
    const promptFileContents = readFileSync(join(worktreePath, "plans", "FIX_CATCH_UP_CONFLICTS.prompt.md"), "utf8");
    assert.ok(promptFileContents.includes(`${worktreePath}/conflicted.ts`), "prompt is missing the conflicted path");
});

test("test_fixCatchUpConflicts_runsTwiceWithTheSameInput", () => {
    // Setup: the same stopped merge and held lock as the first test.
    const projectRoot = makeSourceRepo();
    const worktreePath = makeConflictedRepo("conflicted.ts");
    assert.equal(acquireSourceRepoLock(projectRoot, buildLockOwner("", 2)).status, "acquired");
    const input = inputFor(projectRoot, worktreePath, 2);

    // Test action: run the block twice with the same input.
    const first = main(input);
    const promptAfterFirst = readFileSync(join(worktreePath, "plans", "FIX_CATCH_UP_CONFLICTS.prompt.md"), "utf8");
    const second = main(input);
    const promptAfterSecond = readFileSync(join(worktreePath, "plans", "FIX_CATCH_UP_CONFLICTS.prompt.md"), "utf8");

    // Verification: the output and the prompt file are the same both times.
    assert.deepEqual(second, first);
    assert.equal(promptAfterSecond, promptAfterFirst);
});

test("test_fixCatchUpConflicts_throwsWhenTheWorktreeHasNothingUnmerged", () => {
    // Setup: the worktree is a fresh repo with no merge in progress.
    const projectRoot = makeSourceRepo();
    const worktreePath = mkdtempSync(join(tmpdir(), "fix-catch-up-clean-"));
    git(worktreePath, "init", "--quiet", "--initial-branch=main");
    assert.equal(acquireSourceRepoLock(projectRoot, buildLockOwner("", 3)).status, "acquired");

    // Test action and verification: the block throws instead of writing an empty prompt.
    assert.throws(() => main(inputFor(projectRoot, worktreePath, 3)), /no unmerged paths/);
});

test("test_fixCatchUpConflicts_throwsWhenTheSourceLockIsNotHeldByThisRun", () => {
    // Setup: a stopped merge, but no lock acquired at all.
    const projectRoot = makeSourceRepo();
    const worktreePath = makeConflictedRepo("thing.ts");

    // Test action and verification: the block throws before it writes a prompt.
    assert.throws(() => main(inputFor(projectRoot, worktreePath, 4)), /source repository lock/);
});
