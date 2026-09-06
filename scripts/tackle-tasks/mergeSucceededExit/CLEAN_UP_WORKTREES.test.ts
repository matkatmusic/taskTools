// Behavioral checks for CLEAN_UP_WORKTREES.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./CLEAN_UP_WORKTREES.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { createWorktreeForGroup, readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../shared/prepareTasks.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { git, makeCommittedRepo, addSubmodule } from "../../../tests/support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "CLEAN_UP_WORKTREES.template.json");

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeCommittedRepo("clean-up-worktrees-child-", "child-main");
    const rootOrigin = makeCommittedRepo("clean-up-worktrees-root-", "main");
    addSubmodule(rootOrigin, childOrigin, "child");
    return rootOrigin;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string, runId: string): { worktreePath: string; taskNumber: number; branchName: string } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(
        rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, runId,
    );
    return { worktreePath, taskNumber: groupId, branchName: taskBranchName(groupId) };
}

function samplePacket(projectRoot: string, taskNumber: number, runId: string, worktree: string): Record<string, unknown> {
    return { box: "RECORD_MODIFIED_FILES_SUCCESS", scriptSignal: "continue", projectRoot, taskNumber, runId, worktree };
}

test("test_CLEAN_UP_WORKTREES_leavesEverySourceCheckoutClean", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-51";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");

    const output = main(JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath)));

    assert.equal(output.box, "CLEAN_UP_WORKTREES");
    assert.equal("worktree" in output, false);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(git(rootOrigin, "status", "--porcelain"), "");
    assert.equal(git(join(rootOrigin, "child"), "status", "--porcelain"), "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_CLEAN_UP_WORKTREES_runsTwiceWithTheSameInput", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-52";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");
    const input = JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath));

    const first = main(input);
    const second = main(input);

    assert.deepEqual(second, first);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(readSourceRepoLock(rootOrigin), null);
});

// A lock owned by another run must refuse before any mutation.
test("test_CLEAN_UP_WORKTREES_refusesAndMutatesNothingWhenTheSourceLockIsOwnedByAnotherRun", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-54";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);
    const otherOwner = buildLockOwner("run-other", 999);
    assert.equal(acquireSourceRepoLock(rootOrigin, otherOwner).status, "acquired");

    assert.throws(() => main(JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath))));

    assert.equal(existsSync(worktreePath), true);
    assert.equal(git(rootOrigin, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`).length > 0, true);
    assert.notEqual(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    assert.equal(readSourceRepoLock(rootOrigin)?.owner, otherOwner);
});
