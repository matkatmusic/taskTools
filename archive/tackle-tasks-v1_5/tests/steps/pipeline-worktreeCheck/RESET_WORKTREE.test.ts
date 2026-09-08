// Behavioral checks for scripts/steps/pipeline-worktreeCheck/RESET_WORKTREE.ts, ported from tests/resetTaskWorktree.test.ts's "succeeds when run twice" case. Mutating: temp git repos only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/RESET_WORKTREE.ts";
import { main as takeLeaseBeforeReset } from "../../../scripts/steps/pipeline-worktreeCheck/TAKE_WORKTREE_LEASE_BEFORE_RESET.ts";
import { claimTask, readTaskRunState, updateCurrentTaskRun } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { taskBranchName } from "../../../scripts/tackle-tasks/createTaskWorktree.ts";
import { createFreshTaskWorktree } from "../../../scripts/steps/pipeline-worktreeCheck/_createFreshTaskWorktree.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { git, makeCommittedRepo, addSubmodule } from "../../support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-worktreeCheck/RESET_WORKTREE.template.json");

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_RESET_WORKTREE_tearsDownAndRecreatesACleanWorktreeOnTheTaskBranch", () => {
    const submoduleOrigin = makeCommittedRepo("RESET_WORKTREE-sub-");
    const root = makeCommittedRepo("RESET_WORKTREE-root-");
    addSubmodule(root, submoduleOrigin, "vendor");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-old", root);
    const firstWorktree = createFreshTaskWorktree(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree: firstWorktree, leaseRunId: "run-old" }, root);
    writeFileSync(join(firstWorktree, "dirty.txt"), "leaked work\n");

    // The lease is released by TAKE_WORKTREE_LEASE_BEFORE_RESET before RESET_WORKTREE tears the worktree down.
    const beforeReset = takeLeaseBeforeReset(JSON.stringify({
        box: "IS_WORKTREE_SAFE_TO_USE", scriptSignal: "continue", taskNumber: 1, runId: "run-old",
        projectRoot: root, worktree: firstWorktree, branch: taskBranchName(1), docsMode: "", exitType: "", exitNote: "",
    }));

    const output = main(JSON.stringify(beforeReset));

    assert.equal(output.docsMode, "AUTOGEN");
    assert.ok(existsSync(output.worktree));
    assert.ok(!existsSync(join(output.worktree, "dirty.txt")));
    const currentBranch = git(output.worktree, "branch", "--show-current");
    assert.equal(currentBranch, "task-1");
    assert.equal(readTaskRunState(1, root).worktree, output.worktree);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
