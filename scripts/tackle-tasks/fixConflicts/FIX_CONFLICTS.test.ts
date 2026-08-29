// Behavioral checks for scripts/tackle-tasks/fixConflicts/FIX_CONFLICTS.ts. Run: node --test scripts/tackle-tasks/fixConflicts/FIX_CONFLICTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./FIX_CONFLICTS.ts";
import type { FixConflictsPacket } from "./_packet.ts";
import { buildPromptOutputTemplate } from "../../contracts.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "fix-conflicts-run-log.md");

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

// A committed repo on "main" so the fixture worktree has a real HEAD, not an unborn one.
function makeSourceRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-conflicts-source-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "root");
    return repo;
}

// A repository stopped mid-merge on a real unmerged path, so the box's git query finds it.
function makeConflictedRepo(fileName = "thing.ts"): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-conflicts-worktree-"));
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

function packet(projectRoot: string, worktree: string, taskNumber: number, runId: string): FixConflictsPacket {
    return {
        box: "ARE_2_CONFLICT_FIXES_DONE_Q", scriptSignal: "continue", taskNumber, runId,
        projectRoot, worktree, branch: "task-1", exitType: "", exitNote: "",
        conflicted: true, stoppedOccurrenceId: "", stoppedCheckoutPath: worktree,
        conflictedFilePaths: ["conflicted.ts"], failureReason: "",
    };
}

test("test_FIX_CONFLICTS_printsAPromptNamingTheConflictedPathFromTheWorktree", () => {
    const projectRoot = makeSourceRepo();
    const worktree = makeConflictedRepo("conflicted.ts");
    acquireSourceRepoLock(projectRoot, buildLockOwner("run-1", 1));

    const output = main(JSON.stringify(packet(projectRoot, worktree, 1, "run-1")));

    assert.equal(output.box, "FIX_CONFLICTS");
    assert.equal(output.scriptSignal, "prompt");
    const promptFileContents = readFileSync(join(worktree, "plans", "FIX_CONFLICTS.prompt.md"), "utf8");
    assert.ok(promptFileContents.includes(`${worktree}/conflicted.ts`), "prompt is missing the conflicted path");

    const mismatches = getTemplateShapeMismatches(buildPromptOutputTemplate("FIX_CONFLICTS"), output);
    assert.deepEqual(mismatches, []);
});

test("test_FIX_CONFLICTS_promptNeverMentionsRunStepOrInvokingTheSkill", () => {
    const projectRoot = makeSourceRepo();
    const worktree = makeConflictedRepo("conflicted.ts");
    acquireSourceRepoLock(projectRoot, buildLockOwner("run-4", 4));

    const output = main(JSON.stringify(packet(projectRoot, worktree, 4, "run-4")));

    assert.doesNotMatch(String(output.prompt), /\/run-step|invoke the skill/i);
});

test("test_FIX_CONFLICTS_runsTwiceWithTheSameInput", () => {
    const projectRoot = makeSourceRepo();
    const worktree = makeConflictedRepo("conflicted.ts");
    acquireSourceRepoLock(projectRoot, buildLockOwner("run-5", 5));
    const input = JSON.stringify(packet(projectRoot, worktree, 5, "run-5"));

    const first = main(input);
    const promptAfterFirst = readFileSync(join(worktree, "plans", "FIX_CONFLICTS.prompt.md"), "utf8");

    const second = main(input);
    const promptAfterSecond = readFileSync(join(worktree, "plans", "FIX_CONFLICTS.prompt.md"), "utf8");

    assert.deepEqual(second, first);
    assert.equal(promptAfterSecond, promptAfterFirst);
});

test("test_FIX_CONFLICTS_throwsWhenTheWorktreeHasNothingUnmerged", () => {
    const projectRoot = makeSourceRepo();
    const worktree = mkdtempSync(join(tmpdir(), "fix-conflicts-clean-"));
    git(worktree, "init", "--quiet", "--initial-branch=main");
    acquireSourceRepoLock(projectRoot, buildLockOwner("run-2", 2));

    assert.throws(() => main(JSON.stringify(packet(projectRoot, worktree, 2, "run-2"))), /no unmerged paths/);
});

test("test_FIX_CONFLICTS_throwsWhenTheSourceLockIsNotHeldByThisRun", () => {
    const projectRoot = makeSourceRepo();
    const worktree = makeConflictedRepo("thing.ts");
    // No lock acquired at all: this run does not own the source repo.

    assert.throws(() => main(JSON.stringify(packet(projectRoot, worktree, 3, "run-3"))), /source repository lock/);
});
