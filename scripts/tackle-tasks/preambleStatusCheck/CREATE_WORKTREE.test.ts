// CREATE_WORKTREE.ts is "create a worktree" in pipeline-preambleStatusCheck.mmd. Mutating: exercised only against temp git repos.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./CREATE_WORKTREE.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { taskBranchName, taskWorktreeCreateJournalPath } from "../shared/createTaskWorktree.ts";
import { resolveTaskWorktreeConventionDirectory, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import { git, addSubmodule, makeCommittedRepo } from "../../../tests/support/gitFixtures.ts";

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_CREATE_WORKTREE_createsARealWorktreeOnTheTasksBranchWithSubmodulesPopulated", () => {
    const submoduleOrigin = makeCommittedRepo("CREATE_WORKTREE-sub-");
    const root = makeCommittedRepo("CREATE_WORKTREE-root-");
    addSubmodule(root, submoduleOrigin, "vendor");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);

    const output = main(JSON.stringify({
        box: "DOES_WORKTREE_EXIST_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-a", projectRoot: root,
        worktree: "", branch: taskBranchName(1), docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "CREATE_WORKTREE",
    }));

    assert.ok(existsSync(output.worktree));
    assert.equal(git(output.worktree, "branch", "--show-current"), "task-1");
    assert.ok(existsSync(join(output.worktree, "vendor", "seed.txt")));
    assert.equal(output.docsMode, "");
});

test("test_CREATE_WORKTREE_recoversAfterBeingKilledRightAfterGitWorktreeAdd", async () => {
    const submoduleOrigin = makeCommittedRepo("CREATE_WORKTREE-sub-");
    const root = makeCommittedRepo("CREATE_WORKTREE-root-");
    addSubmodule(root, submoduleOrigin, "vendor");
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", files: [] }]);
    claimTask(1, "run-a", root);
    const packet = JSON.stringify({
        box: "DOES_WORKTREE_EXIST_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-a", projectRoot: root,
        worktree: "", branch: taskBranchName(1), docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "CREATE_WORKTREE",
    });

    // Test action: kill a real child right after `git worktree add` succeeds inside CREATE_WORKTREE's own main().
    const scriptPath = join(import.meta.dirname, "CREATE_WORKTREE.ts");
    const child = spawn(process.execPath, [scriptPath, packet], {
        stdio: "inherit",
        env: { ...process.env, CREATEWORKTREEFORGROUP_TEST_KILL_AFTER: "gitCreate" },
    });
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL", `expected the child to die of SIGKILL after step "gitCreate"`);

    // Test action: retry the same box in-process; must not throw.
    const output = main(packet);

    // Verification: a real worktree exists on task-1, submodules populated, the current run's
    // lease is the one surviving `.lease` file, and no create-journal remains.
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    assert.ok(existsSync(output.worktree));
    assert.equal(git(output.worktree, "branch", "--show-current"), "task-1");
    assert.ok(existsSync(join(output.worktree, "vendor", "seed.txt")));
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(expectedWorktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-a");
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(expectedWorktree)));
});
