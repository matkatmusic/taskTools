// Behavioral checks for scripts/steps/pipeline-suite/REBASED_WORKTREE_INPUT.ts.  Run: node --test tests/steps/pipeline-suite/REBASED_WORKTREE_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-suite/REBASED_WORKTREE_INPUT.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";
import { makeCommittedRepo, makeLinkedWorktree } from "../../support/gitFixtures.ts";

function seedTaskWithBrief(rootOrigin: string, worktreePath: string, taskNumber: number, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "fixture task", files }]);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, `plans/brief-${taskNumber}.md`), "brief\n");
}

test("test_REBASED_WORKTREE_INPUT_derivesOwnedFilesAndForwardsTheFixAttemptCounter", () => {
    const rootOrigin = makeCommittedRepo();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 501;
    seedTaskWithBrief(rootOrigin, worktreePath, taskNumber, ["seed.txt"]);

    const input = JSON.stringify({
        taskNumber, runId: "run-1", projectRoot: rootOrigin, worktreePath, rootSourceBranch: "main",
        suiteFixAttempts: 2,
    });
    const output = main(input);

    assert.equal(output.box, "REBASED_WORKTREE_INPUT");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, taskNumber);
    assert.equal(output.runId, "run-1");
    assert.equal(output.projectRoot, rootOrigin);
    assert.equal(output.worktreePath, worktreePath);
    assert.equal(output.rootSourceBranch, "main");
    assert.deepEqual(output.ownedFilePaths, [`${worktreePath}/seed.txt`]);
    assert.equal(output.suiteFixAttempts, 2);
});
