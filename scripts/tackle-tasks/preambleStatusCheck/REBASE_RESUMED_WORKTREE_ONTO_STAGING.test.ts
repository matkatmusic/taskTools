// Tests rebasing the worktree onto staging when staging has moved, per pipeline-preambleStatusCheck.mmd, against real git repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { createTaskWorktree } from "../shared/createTaskWorktree.ts";
import { readSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { readRetainedRebaseIntent, writeRebaseIntent } from "../shared/rebaseIntent.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "REBASE_RESUMED_WORKTREE_ONTO_STAGING.template.json");
const TEMPLATE = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeProjectRoot(taskNumber: number): string {
    const root = mkdtempSync(join(tmpdir(), "rebase-resumed-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "seed");
    git(root, "branch", "staging");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber, title: "t", modifiableFiles: [] }]));
    return root;
}

function commitTaskWork(worktree: string): string {
    writeFileSync(join(worktree, "task-work.txt"), "task work\n");
    git(worktree, "add", "task-work.txt");
    git(worktree, "commit", "-q", "-m", "task work");
    return git(worktree, "rev-parse", "HEAD");
}

function moveStaging(root: string): string {
    git(root, "checkout", "-q", "staging");
    writeFileSync(join(root, "staging-moved.txt"), "staging moved\n");
    git(root, "add", "staging-moved.txt");
    git(root, "commit", "-q", "-m", "staging moved");
    return git(root, "rev-parse", "HEAD");
}

function packet(projectRoot: string, worktree: string, taskNumber: number, runId: string): string {
    return JSON.stringify({
        box: "IS_PREVIOUS_RUN_RESUMABLE_Q", scriptSignal: "continue", taskNumber, runId, projectRoot, worktree,
        branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "", next: "REBASE_RESUMED_WORKTREE_ONTO_STAGING",
    });
}

test("test_REBASE_RESUMED_WORKTREE_ONTO_STAGING_rebasesOntoTheNewStagingTipAndReleasesTheLock", async () => {
    const root = makeProjectRoot(1);
    claimTask(1, "run-1", root);
    const { worktree } = createTaskWorktree(1, "run-1", root);
    commitTaskWork(worktree);
    const newStagingTip = moveStaging(root);

    const output = await main(packet(root, worktree, 1, "run-1"));

    assert.deepEqual(getTemplateShapeMismatches(TEMPLATE.output, output), []);
    assert.equal(output.next, "DOES_FENCE_COVER_WORKTREE_Q");
    assert.equal(output.rebased, true);
    assert.equal(output.conflicted, false);
    assert.equal(output.returnTo, "");
    assert.equal(git(worktree, "merge-base", "--is-ancestor", newStagingTip, "HEAD"), "");
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "task work");
    assert.equal(readSourceRepoLock(root), null);
});

test("test_REBASE_RESUMED_WORKTREE_ONTO_STAGING_skipsWhenStagingHasNotMoved", async () => {
    const root = makeProjectRoot(2);
    claimTask(2, "run-2", root);
    const { worktree } = createTaskWorktree(2, "run-2", root);
    const headBefore = commitTaskWork(worktree);

    const output = await main(packet(root, worktree, 2, "run-2"));

    assert.deepEqual(getTemplateShapeMismatches(TEMPLATE.output, output), []);
    assert.equal(output.next, "DOES_FENCE_COVER_WORKTREE_Q");
    assert.equal(output.rebased, false);
    assert.equal(git(worktree, "rev-parse", "HEAD"), headBefore);
    assert.equal(readSourceRepoLock(root), null);
});

test("test_REBASE_RESUMED_WORKTREE_ONTO_STAGING_routesConflictsToTheFixPathWithReturnToAndKeepsTheLock", async () => {
    const root = makeProjectRoot(3);
    claimTask(3, "run-3", root);
    const { worktree } = createTaskWorktree(3, "run-3", root);
    writeFileSync(join(worktree, "shared.txt"), "task side\n");
    git(worktree, "add", "shared.txt");
    git(worktree, "commit", "-q", "-m", "task side");
    git(root, "checkout", "-q", "staging");
    writeFileSync(join(root, "shared.txt"), "staging side\n");
    git(root, "add", "shared.txt");
    git(root, "commit", "-q", "-m", "staging side");

    const output = await main(packet(root, worktree, 3, "run-3"));

    assert.deepEqual(getTemplateShapeMismatches(TEMPLATE.output, output), []);
    assert.equal(output.next, "pipeline-commitMergeConflictFixIfNeeded.mmd::ARE_2_CONFLICT_FIXES_DONE_Q");
    assert.equal(output.conflicted, true);
    assert.deepEqual(output.conflictedFilePaths, ["shared.txt"]);
    assert.equal(output.returnTo, "pipeline-preambleStatusCheck.mmd::DOES_FENCE_COVER_WORKTREE_Q");
    assert.notEqual(readSourceRepoLock(root), null);
});

test("test_REBASE_RESUMED_WORKTREE_ONTO_STAGING_honorsARetainedIntentWhenStagingHasNotMoved", async () => {
    const root = makeProjectRoot(4);
    claimTask(4, "run-4", root);
    const { worktree } = createTaskWorktree(4, "run-4", root);
    commitTaskWork(worktree);
    const targetInput = JSON.stringify({ taskNumber: 4, runId: "run-4", worktree, projectRoot: root, box: "", scriptSignal: "" });
    writeRebaseIntent(worktree, { taskNumber: 4, runId: "run-4", targetBlock: "pipeline-x.mmd::TARGET_BLOCK", targetInput });

    const output = await main(packet(root, worktree, 4, "run-4"));

    // Required keys must still match the output contract, even though a retained intent overrides `next`.
    assert.deepEqual(getTemplateShapeMismatches(TEMPLATE.output, output), []);
    assert.equal(output.next, "pipeline-x.mmd::TARGET_BLOCK");
    assert.equal((output as unknown as { taskNumber: number }).taskNumber, 4);
    assert.equal(readRetainedRebaseIntent(worktree), null);
});

test("test_REBASE_RESUMED_WORKTREE_ONTO_STAGING_honorsARetainedIntentAfterACleanRebase", async () => {
    const root = makeProjectRoot(5);
    claimTask(5, "run-5", root);
    const { worktree } = createTaskWorktree(5, "run-5", root);
    commitTaskWork(worktree);
    moveStaging(root);
    const targetInput = JSON.stringify({ taskNumber: 5, runId: "run-5", worktree, projectRoot: root, box: "", scriptSignal: "" });
    writeRebaseIntent(worktree, { taskNumber: 5, runId: "run-5", targetBlock: "pipeline-x.mmd::TARGET_BLOCK", targetInput });

    const output = await main(packet(root, worktree, 5, "run-5"));

    assert.deepEqual(getTemplateShapeMismatches(TEMPLATE.output, output), []);
    assert.equal(output.next, "pipeline-x.mmd::TARGET_BLOCK");
    assert.equal((output as unknown as { taskNumber: number }).taskNumber, 5);
    assert.equal(readRetainedRebaseIntent(worktree), null);
});

test("test_REBASE_RESUMED_WORKTREE_ONTO_STAGING_returnToNamesTheRetainedTargetOnConflict", async () => {
    const root = makeProjectRoot(6);
    claimTask(6, "run-6", root);
    const { worktree } = createTaskWorktree(6, "run-6", root);
    writeFileSync(join(worktree, "shared.txt"), "task side\n");
    git(worktree, "add", "shared.txt");
    git(worktree, "commit", "-q", "-m", "task side");
    git(root, "checkout", "-q", "staging");
    writeFileSync(join(root, "shared.txt"), "staging side\n");
    git(root, "add", "shared.txt");
    git(root, "commit", "-q", "-m", "staging side");
    const targetInput = JSON.stringify({ taskNumber: 6, runId: "run-6", worktree, projectRoot: root, box: "", scriptSignal: "" });
    writeRebaseIntent(worktree, { taskNumber: 6, runId: "run-6", targetBlock: "pipeline-x.mmd::TARGET_BLOCK", targetInput });

    const output = await main(packet(root, worktree, 6, "run-6"));

    assert.deepEqual(getTemplateShapeMismatches(TEMPLATE.output, output), []);
    assert.equal(output.next, "pipeline-commitMergeConflictFixIfNeeded.mmd::ARE_2_CONFLICT_FIXES_DONE_Q");
    assert.equal(output.returnTo, "pipeline-x.mmd::TARGET_BLOCK");
    // Not cleared yet: IS_REBASE_FINISHED_Q clears it once the conflict is actually resolved.
    assert.notEqual(readRetainedRebaseIntent(worktree), null);
});
