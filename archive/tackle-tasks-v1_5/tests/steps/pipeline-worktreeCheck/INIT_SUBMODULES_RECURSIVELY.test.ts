// Behavioral checks for scripts/steps/pipeline-worktreeCheck/INIT_SUBMODULES_RECURSIVELY.ts, ported from tests/initTaskSubmodules.test.ts. Mutating: exercised only against temp git repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-worktreeCheck/INIT_SUBMODULES_RECURSIVELY.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-worktreeCheck/INIT_SUBMODULES_RECURSIVELY.template.json");

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_INIT_SUBMODULES_RECURSIVELY_isANoOpAfterCreateWorktreeForGroupAlreadyPopulatedThem", () => {
    // Setup: createWorktreeForGroup (via makeLinkedWorktree) already populates submodules.
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_301;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    seedTasksFile(rootOrigin, [{ taskNumber: groupId, title: "t", files: [] }]);
    claimTask(groupId, "run-a", rootOrigin);

    const output = main(JSON.stringify({
        box: "DOES_FENCE_COVER_WORKTREE", scriptSignal: "continue", taskNumber: groupId, runId: "run-a",
        projectRoot: rootOrigin, worktree: worktreePath, branch: `task-${groupId}`, docsMode: "UPDATE", exitType: "", exitNote: "",
    }));

    assert.equal(output.box, "INIT_SUBMODULES_RECURSIVELY");
    assert.ok(existsSync(join(worktreePath, "child", "seed.txt")));
    assert.ok(existsSync(join(worktreePath, "child", "grandchild", "seed.txt")));

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
