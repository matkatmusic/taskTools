// Behavioral checks for scripts/steps/pipeline-suite/COMMIT_SUITE_FIX_IF_NEEDED.ts. Mutating: commits in a real temp worktree, never this repo's tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-suite/COMMIT_SUITE_FIX_IF_NEEDED.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../support/gitFixtures.ts";

const TEMPLATE_PATH = join(
    dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-suite/COMMIT_SUITE_FIX_IF_NEEDED.template.json",
);

function seedClaimedTask(rootOrigin: string, taskNumber: number): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "fixture task", files: [] }]);
    const outcome = claimTask(taskNumber, "run-1", rootOrigin);
    assert.equal(outcome.status, "claimed");
}

test("test_COMMIT_SUITE_FIX_IF_NEEDED_commitsDirtyWorkAndForwardsThePacketToRunTheSuiteAgain", () => {
    const rootOrigin = makeCommittedRepo();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 801;
    seedClaimedTask(rootOrigin, taskNumber);
    writeFileSync(join(worktreePath, "fixed.txt"), "fixed\n");

    const input = JSON.stringify({
        taskNumber, runId: "run-1", projectRoot: rootOrigin, worktreePath, rootSourceBranch: "main",
        ownedFilePaths: [], testFilePaths: [], suiteFixAttempts: 1,
    });
    const output = main(input);

    assert.equal(output.box, "COMMIT_SUITE_FIX_IF_NEEDED");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.suiteFixAttempts, 1);
    assert.equal(git(worktreePath, "status", "--porcelain"), "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
