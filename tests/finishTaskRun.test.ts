// Behavioral checks for finishFailedRun in scripts/tackle-tasks/finishTaskRun.ts.  Run: node --test tests/tackle-tasks/finishTaskRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finishFailedRun } from "../../scripts/tackle-tasks/finishTaskRun.ts";
import { claimTask, readTaskRunState } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { taskBranchName } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { buildWorktreeOccurrences } from "../../scripts/tackle-tasks/occurrences.ts";
import { git, makeLayeredSubmoduleFixture } from "./support/gitFixtures.ts";

const TASK_NUMBER = 1;
const RUN_ID = "run-a";
const SOURCE_BRANCH = "master"; // gitFixtures repos are `git init` with no -b, so the default branch is master.

let nextGroupId = 500_000;

// createWorktreeForGroup takes the lease under the given runId; the gitFixtures helper leaves runId to chance.
function createLinkedWorktree(rootOrigin: string, runId: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, runId);
}

function setupClaimedTask(): { rootOrigin: string; worktreePath: string } {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = createLinkedWorktree(rootOrigin, RUN_ID);
    writeFileSync(join(rootOrigin, "tasks.json"), `${JSON.stringify([{ taskNumber: TASK_NUMBER, title: "t", files: [] }], null, 2)}\n`);
    const outcome = claimTask(TASK_NUMBER, RUN_ID, rootOrigin);
    assert.equal(outcome.status, "claimed");
    acquireSourceRepoLock(rootOrigin, buildLockOwner(RUN_ID, TASK_NUMBER));
    return { rootOrigin, worktreePath };
}

// Writes the merge ref for the first `count` layers, exactly as mergeTaskWorktrees does when one lands.
function landLayers(worktreePath: string, projectRoot: string, count: number): void {
    const branch = taskBranchName(TASK_NUMBER);
    const occurrences = buildWorktreeOccurrences(worktreePath, projectRoot);
    for (const occurrence of occurrences.slice(0, count)) {
        const oid = git(occurrence.sourceCheckoutPath, "rev-parse", "HEAD");
        git(occurrence.sourceCheckoutPath, "update-ref", `refs/taskTools/merged-commits/${branch}`, oid);
    }
}

test("test_finishFailedRun_writesTheIncomingExitTypeWhenNoLayerLanded", () => {
    const { rootOrigin, worktreePath } = setupClaimedTask();

    const output = finishFailedRun({
        taskNumber: TASK_NUMBER, runId: RUN_ID, projectRoot: rootOrigin, worktree: worktreePath,
        sourceBranch: SOURCE_BRANCH, exitType: "run-failed", exitNote: "boom",
    });

    assert.equal(output.exitType, "run-failed");
    assert.equal(output.publicationState, "NONE LANDED");
    assert.equal(output.workLanded, false);
    const state = readTaskRunState(TASK_NUMBER, rootOrigin);
    assert.equal(state.history[state.history.length - 1].exitType, "run-failed");
});

test("test_finishFailedRun_writesPartiallyPublishedWhenOnlySomeLayersLanded", () => {
    const { rootOrigin, worktreePath } = setupClaimedTask();
    landLayers(worktreePath, rootOrigin, 1);

    const output = finishFailedRun({
        taskNumber: TASK_NUMBER, runId: RUN_ID, projectRoot: rootOrigin, worktree: worktreePath,
        sourceBranch: SOURCE_BRANCH, exitType: "run-failed", exitNote: "boom",
    });

    assert.equal(output.exitType, "partially-published");
    assert.equal(output.publicationState, "SOME LANDED");
    assert.equal(output.workLanded, true);
});

test("test_finishFailedRun_marksTheTaskInactiveAndReleasesTheLease", () => {
    const { rootOrigin, worktreePath } = setupClaimedTask();
    rmSync(worktreePath, { recursive: true, force: true });

    const output = finishFailedRun({
        taskNumber: TASK_NUMBER, runId: RUN_ID, projectRoot: rootOrigin, worktree: worktreePath,
        sourceBranch: SOURCE_BRANCH, exitType: "run-failed", exitNote: "boom",
    });

    assert.equal(output.leaseReleased, true);
    const state = readTaskRunState(TASK_NUMBER, rootOrigin);
    assert.equal(state.active, false);
    assert.notEqual(state.history[state.history.length - 1].endedAt, null);
});
