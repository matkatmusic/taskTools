// Real-git tests for B_FIX_RESUMED_REBASE_CONFLICTS: prompt names unmerged paths, lock stays held; lost lock or clean checkout throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./FIX_RESUMED_REBASE_CONFLICTS.ts";
import { buildPromptOutputTemplate } from "../../shared/contracts.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../shared/sourceRepoLock.ts";

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

// A committed repo on "main", so the source-repo lock has a real .git folder to live in.
function makeSourceRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-resumed-source-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "root");
    return repo;
}

// A repository stopped on a real unmerged path, like the checkout a resumed-worktree rebase stops in.
function makeConflictedRepo(fileName: string): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-resumed-stopped-"));
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

// The conflict output of Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING, with `next` already dropped by the engine.
const inputFor = (projectRoot: string, worktree: string, stoppedCheckoutPath: string, taskNumber: number, runId: string): string => JSON.stringify({
    box: "Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING",
    scriptSignal: "continue",
    taskNumber,
    runId,
    projectRoot,
    worktree,
    branch: `task-${taskNumber}`,
    docsMode: "",
    planFile: "",
    exitType: "",
    exitNote: "",
    rebased: true,
    conflicted: true,
    stoppedOccurrenceId: "",
    stoppedCheckoutPath,
    conflictedFilePaths: ["conflicted.ts"],
    failureReason: "",
    returnTo: "pipeline-preambleStatusCheck.mmd::DOES_FENCE_COVER_WORKTREE_Q",
});

test("test_fixResumedRebaseConflicts_printsAPromptNamingTheConflictedPathFromTheStoppedCheckout", () => {
    // Setup: the stopped checkout is separate from the task worktree; this run holds the source-repo lock.
    const projectRoot = makeSourceRepo();
    const worktree = mkdtempSync(join(tmpdir(), "fix-resumed-worktree-"));
    const stoppedCheckoutPath = makeConflictedRepo("conflicted.ts");
    assert.equal(acquireSourceRepoLock(projectRoot, buildLockOwner("run-1", 1)).status, "acquired");

    // Test action: run the block.
    const output = main(inputFor(projectRoot, worktree, stoppedCheckoutPath, 1, "run-1"));

    // Verification: the prompt names the stopped checkout's conflicted path, and the lock is still this run's.
    const promptFile = join(worktree, "plans", "FIX_RESUMED_REBASE_CONFLICTS.prompt.md");
    assert.deepEqual(output, {
        box: "B_FIX_RESUMED_REBASE_CONFLICTS",
        scriptSignal: "prompt",
        prompt: `invoke '/read-file "${promptFile}"' and follow the instructions.`,
    });
    assert.deepEqual(getTemplateShapeMismatches(buildPromptOutputTemplate("B_FIX_RESUMED_REBASE_CONFLICTS"), output), []);
    assert.doesNotMatch(String(output.prompt), /\/run-step|invoke the skill/i);
    const promptFileContents = readFileSync(promptFile, "utf8");
    assert.ok(promptFileContents.startsWith("## YOUR JOB"), "prompt does not start with YOUR JOB");
    assert.ok(promptFileContents.includes(`- \`${stoppedCheckoutPath}/conflicted.ts\``), "prompt is missing the conflicted path");
    assert.equal(readSourceRepoLock(projectRoot)?.owner, "run-1:1");
});

test("test_fixResumedRebaseConflicts_runsTwiceWithTheSameInput", () => {
    // Setup: the same stopped checkout and held lock as the first test.
    const projectRoot = makeSourceRepo();
    const worktree = mkdtempSync(join(tmpdir(), "fix-resumed-worktree-"));
    const stoppedCheckoutPath = makeConflictedRepo("conflicted.ts");
    assert.equal(acquireSourceRepoLock(projectRoot, buildLockOwner("run-2", 2)).status, "acquired");
    const input = inputFor(projectRoot, worktree, stoppedCheckoutPath, 2, "run-2");
    const promptFile = join(worktree, "plans", "FIX_RESUMED_REBASE_CONFLICTS.prompt.md");

    // Test action: run the block twice with the same input.
    const first = main(input);
    const promptAfterFirst = readFileSync(promptFile, "utf8");
    const second = main(input);
    const promptAfterSecond = readFileSync(promptFile, "utf8");

    // Verification: the output and the prompt file are the same both times.
    assert.deepEqual(second, first);
    assert.equal(promptAfterSecond, promptAfterFirst);
});

test("test_fixResumedRebaseConflicts_throwsWhenTheStoppedCheckoutHasNothingUnmerged", () => {
    // Setup: the stopped checkout is a fresh repo with nothing unmerged.
    const projectRoot = makeSourceRepo();
    const worktree = mkdtempSync(join(tmpdir(), "fix-resumed-worktree-"));
    const stoppedCheckoutPath = mkdtempSync(join(tmpdir(), "fix-resumed-clean-"));
    git(stoppedCheckoutPath, "init", "--quiet", "--initial-branch=main");
    assert.equal(acquireSourceRepoLock(projectRoot, buildLockOwner("run-3", 3)).status, "acquired");

    // Test action and verification: the block throws instead of writing an empty prompt.
    assert.throws(() => main(inputFor(projectRoot, worktree, stoppedCheckoutPath, 3, "run-3")), /no unmerged paths/);
});

test("test_fixResumedRebaseConflicts_throwsWhenTheSourceLockIsHeldByAnotherRun", () => {
    // Setup: a stopped checkout, but another run owns the source-repo lock.
    const projectRoot = makeSourceRepo();
    const worktree = mkdtempSync(join(tmpdir(), "fix-resumed-worktree-"));
    const stoppedCheckoutPath = makeConflictedRepo("thing.ts");
    assert.equal(acquireSourceRepoLock(projectRoot, buildLockOwner("run-other", 4)).status, "acquired");

    // Test action and verification: the block throws before it writes a prompt, and the other run keeps the lock.
    assert.throws(() => main(inputFor(projectRoot, worktree, stoppedCheckoutPath, 4, "run-4")), /source repository lock/);
    assert.equal(readSourceRepoLock(projectRoot)?.owner, "run-other:4");
});
