// Behavioral checks for scripts/tackle-tasks/runFullSuite/DID_CHANGES_STAY_INSIDE_FENCE_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./DID_CHANGES_STAY_INSIDE_FENCE_Q.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "DID_CHANGES_STAY_INSIDE_FENCE_Q.template.json");

function seedTask(rootOrigin: string, taskNumber: number, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "fixture task", files }]);
}

function packet(taskNumber: number, projectRoot: string, worktree: string): string {
    return JSON.stringify({
        taskNumber, runId: "run-1", projectRoot, worktree, branch: `task-${taskNumber}`,
        ownedFilePaths: [], testFilePaths: [], passed: true, output: "suite output",
    });
}

test("test_DID_CHANGES_STAY_INSIDE_FENCE_Q_choosesMergeWhenNothingChanged", () => {
    const rootOrigin = makeCommittedRepo("git-fixture-", "main");
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 701;
    seedTask(rootOrigin, taskNumber, ["seed.txt"]);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-1", taskNumber)).status, "acquired");

    const output = main(packet(taskNumber, rootOrigin, worktree));

    assert.equal(output.next, "MERGE_WORKTREES");
    assert.equal(output.exitType, "");
    assert.equal(output.exitNote, "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_DID_CHANGES_STAY_INSIDE_FENCE_Q_choosesExitWhenAnUnownedFileChanged", () => {
    const rootOrigin = makeCommittedRepo("git-fixture-", "main");
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 702;
    seedTask(rootOrigin, taskNumber, []);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-1", taskNumber)).status, "acquired");
    writeFileSync(join(worktree, "sneaky.txt"), "not owned\n");
    git(worktree, "add", "sneaky.txt");
    git(worktree, "commit", "-q", "-m", "sneaky edit");

    const output = main(packet(taskNumber, rootOrigin, worktree));

    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "fence-violation");
    assert.match(String(output.exitNote), /task does not own/);
});
