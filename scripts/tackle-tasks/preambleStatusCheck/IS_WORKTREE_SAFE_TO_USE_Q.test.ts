// IS_WORKTREE_SAFE_TO_USE_Q.ts is "is the worktree safe to use?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/IS_WORKTREE_SAFE_TO_USE_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { main } from "./IS_WORKTREE_SAFE_TO_USE_Q.ts";
import { makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

function packet(worktree: string, groupId: number): string {
    return JSON.stringify({
        box: "DOES_WORKTREE_EXIST_Q", scriptSignal: "continue", taskNumber: groupId, runId: "run-1",
        projectRoot: "/tmp/unused", worktree, branch: `task-${groupId}`, docsMode: "", planFile: "",
        exitType: "", exitNote: "", next: "IS_WORKTREE_SAFE_TO_USE_Q",
    });
}

test("test_IS_WORKTREE_SAFE_TO_USE_Q_choosesIsPreviousRunResumableWhenTheWorktreeIsSafe", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_201;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    const output = main(packet(worktreePath, groupId));
    assert.equal(output.next, "IS_PREVIOUS_RUN_RESUMABLE_Q");
});

test("test_IS_WORKTREE_SAFE_TO_USE_Q_choosesTakeWorktreeLeaseBeforeResetWhenHeadIsOnTheWrongBranch", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_202;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    execFileSync("git", ["-C", worktreePath, "checkout", "-b", "some-other-branch"], { stdio: "ignore" });
    const output = main(packet(worktreePath, groupId));
    assert.equal(output.next, "TAKE_WORKTREE_LEASE_BEFORE_RESET");
});
