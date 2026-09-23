// Real-git tests for Q_CONTINUE_RESUMED_REBASE: the rebase finishes, the next commit conflicts again, or a marker is left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./CONTINUE_RESUMED_REBASE.ts";
import { main as rebaseResumedWorktree } from "./REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { createTaskWorktree } from "../shared/createTaskWorktree.ts";
import { buildLockOwner, readSourceRepoLock } from "../shared/sourceRepoLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function commitShared(checkoutPath: string, content: string): void {
    writeFileSync(join(checkoutPath, "shared.txt"), content);
    git(checkoutPath, "add", "shared.txt");
    git(checkoutPath, "commit", "-q", "-m", content.trim());
}

// A resumed worktree whose task commits edit shared.txt, rebased by the real block onto a staging editing it too.
async function stopResumedRebaseOnAConflict(taskNumber: number, runId: string, taskEdits: string[]): Promise<Record<string, unknown>> {
    const root = mkdtempSync(join(tmpdir(), "continue-resumed-rebase-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "seed");
    git(root, "branch", "staging");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber, title: "t", modifiableFiles: [] }]));
    claimTask(taskNumber, runId, root);
    const { worktree } = createTaskWorktree(taskNumber, runId, root);
    for (const content of taskEdits) commitShared(worktree, content);
    git(root, "checkout", "-q", "staging");
    commitShared(root, "staging side\n");

    const stopped = await rebaseResumedWorktree(JSON.stringify({
        box: "Q_PREVIOUS_RUN_LEFT_NOTES", scriptSignal: "continue", taskNumber, runId, projectRoot: root, worktree,
        branch: `task-${taskNumber}`, docsMode: "", planFile: "", exitType: "", exitNote: "",
    }));
    assert.equal(stopped.conflicted, true);
    // The engine hands the fixing agent's answer on merged over the prompt block's input.
    return { ...stopped, box: "B_FIX_RESUMED_REBASE_CONFLICTS", message: "", additionalData: { resolved: true, unresolvedPaths: [] } };
}

test("test_Q_CONTINUE_RESUMED_REBASE_finishesAndReleasesTheLock", async () => {
    // Setup: one task commit conflicts with staging, and the agent resolved the marker by hand.
    const packet = await stopResumedRebaseOnAConflict(820, "run-820", ["task side\n"]);
    writeFileSync(join(String(packet.stoppedCheckoutPath), "shared.txt"), "resolved\n");

    // Test action: run the block.
    const result = main(JSON.stringify(packet));

    // Verification: the walk goes on to the fence check with the lock released and the fix committed.
    assert.equal(result.box, "Q_CONTINUE_RESUMED_REBASE");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.next, "Q_DOES_FENCE_COVER_WORKTREE_Q");
    assert.equal(result.conflicted, false);
    assert.equal(readSourceRepoLock(String(packet.projectRoot)), null);
    assert.equal(git(String(packet.worktree), "show", "HEAD:shared.txt"), "resolved");
    assert.equal(git(String(packet.worktree), "status", "--porcelain"), "");
});

test("test_Q_CONTINUE_RESUMED_REBASE_loopsBackOnANewConflict", async () => {
    // Setup: two task commits edit shared.txt; the agent resolved the first one's conflict.
    const packet = await stopResumedRebaseOnAConflict(821, "run-821", ["task side 1\n", "task side 2\n"]);
    writeFileSync(join(String(packet.stoppedCheckoutPath), "shared.txt"), "resolved 1\n");

    // Test action: run the block.
    const result = main(JSON.stringify(packet));

    // Verification: the second commit conflicts, so the walk goes back to the fixing agent with the lock still held.
    assert.equal(result.next, "B_FIX_RESUMED_REBASE_CONFLICTS");
    assert.equal(result.conflicted, true);
    assert.deepEqual(result.conflictedFilePaths, ["shared.txt"]);
    assert.equal(result.stoppedCheckoutPath, packet.worktree);
    assert.equal(readSourceRepoLock(String(packet.projectRoot))?.owner, buildLockOwner("run-821", 821));
});

test("test_Q_CONTINUE_RESUMED_REBASE_throwsWhenAMarkerRemains", async () => {
    // Setup: the answer says resolved, but shared.txt still holds the conflict markers.
    const packet = await stopResumedRebaseOnAConflict(822, "run-822", ["task side\n"]);

    // Test action and verification: the block refuses to stage a marked file.
    assert.throws(() => main(JSON.stringify(packet)), /still hold a conflict marker/);
});
