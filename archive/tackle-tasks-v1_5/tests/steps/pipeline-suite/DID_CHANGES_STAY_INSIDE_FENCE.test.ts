// Behavioral checks for scripts/steps/pipeline-suite/DID_CHANGES_STAY_INSIDE_FENCE.ts.  Run: node --test tests/steps/pipeline-suite/DID_CHANGES_STAY_INSIDE_FENCE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-suite/DID_CHANGES_STAY_INSIDE_FENCE.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../support/gitFixtures.ts";

function seedTask(rootOrigin: string, taskNumber: number, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "fixture task", files }]);
}

function packet(taskNumber: number, projectRoot: string, worktreePath: string): string {
    return JSON.stringify({
        taskNumber, runId: "run-1", projectRoot, worktreePath, rootSourceBranch: "main",
        ownedFilePaths: ["seed.txt"], testFilePaths: [], suiteFixAttempts: 1, output: "suite output",
    });
}

test("test_DID_CHANGES_STAY_INSIDE_FENCE_choosesMergeWhenNothingChanged", () => {
    const rootOrigin = makeCommittedRepo("git-fixture-", "main");
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 701;
    seedTask(rootOrigin, taskNumber, ["seed.txt"]);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-1", taskNumber)).status, "acquired");

    const output = main(packet(taskNumber, rootOrigin, worktreePath));

    assert.equal(output.next, "MERGE_PIPELINE");
    assert.equal(output.exitType, "");
    assert.equal(output.exitNote, "");
    assert.deepEqual(output.ownedFilePaths, ["seed.txt"]);
    assert.equal(output.suiteFixAttempts, 1);
    assert.equal(output.output, "suite output");
});

test("test_DID_CHANGES_STAY_INSIDE_FENCE_choosesExitWhenAnUnownedFileChanged", () => {
    const rootOrigin = makeCommittedRepo("git-fixture-", "main");
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 702;
    seedTask(rootOrigin, taskNumber, []);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-1", taskNumber)).status, "acquired");
    writeFileSync(join(worktreePath, "sneaky.txt"), "not owned\n");
    git(worktreePath, "add", "sneaky.txt");
    git(worktreePath, "commit", "-q", "-m", "sneaky edit");

    const output = main(packet(taskNumber, rootOrigin, worktreePath));

    assert.equal(output.next, "EXIT_WORKFLOW_SUITE");
    assert.equal(output.exitType, "fence-violation");
    assert.match(String(output.exitNote), /task does not own/);
});
