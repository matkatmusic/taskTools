// Behavioral checks for scripts/steps/pipeline-worktreeCheck/TAKE_WORKTREE_LEASE.ts, ported from tests/createTaskWorktree.test.ts's state-recording assertion. Mutating: exercised only against temp git repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/TAKE_WORKTREE_LEASE.ts";
import { claimTask, readTaskRunState } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { taskBranchName } from "../../../scripts/tackle-tasks/createTaskWorktree.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { makeCommittedRepo } from "../../support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-worktreeCheck/TAKE_WORKTREE_LEASE.template.json");

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_TAKE_WORKTREE_LEASE_recordsTheWorktreePathAndLeaseRunIdOnTheActiveRun", () => {
    const root = makeCommittedRepo("TAKE_WORKTREE_LEASE-");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);
    const worktree = join(root, "..", "task-1-worktree");

    const output = main(JSON.stringify({
        box: "CREATE_WORKTREE", scriptSignal: "continue", taskNumber: 1, runId: "run-a",
        projectRoot: root, worktree, branch: taskBranchName(1), docsMode: "AUTOGEN", exitType: "", exitNote: "",
    }));

    assert.equal(output.box, "TAKE_WORKTREE_LEASE");
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, worktree);
    assert.equal(state.leaseRunId, "run-a");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
