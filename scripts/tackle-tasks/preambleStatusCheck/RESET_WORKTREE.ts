// RESET_WORKTREE, from pipeline-preambleStatusCheck.mmd. Mutating: tears down and recreates the worktree. "reset the worktree"
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { deleteTaskMergePersistence, removeWorktreeAndBranch } from "../../merge-worktree-tasks/mergeTaskWorktrees.ts";
import { releaseTaskWorktreeLease, taskWorktreeLeasePath } from "../../shared/prepareTasks.ts";
import { createFreshTaskWorktree } from "../shared/_createFreshTaskWorktree.ts";
import { readTaskRunState, updateCurrentTaskRun } from "../shared/taskRunState.ts";
import { clearResetIntent, writeResetIntent } from "../shared/resetIntent.ts";
import type { EntryPacket } from "./_packet.ts";

// Test-only: SIGKILLs this process right after the old worktree/branch are torn down, before
// the stale-lease cleanup and recreate steps run.
function killSelfForTest(): void {
    if (process.env.RESETWORKTREE_TEST_KILL_AFTER_DELETE === "1") process.kill(process.pid, "SIGKILL");
}

export function main(input: string): EntryPacket {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const state = readTaskRunState(packet.taskNumber, packet.projectRoot);
    if (state.leaseRunId !== packet.runId) {
        throw new Error(`worktree lease for task ${packet.taskNumber} is not held by run "${packet.runId}", refusing reset`);
    }
    writeResetIntent({
        taskNumber: packet.taskNumber, runId: packet.runId, worktreePath: packet.worktree,
        branch: packet.branch, createdAt: new Date().toISOString(),
    });
    deleteTaskMergePersistence(packet.projectRoot, packet.branch);
    removeWorktreeAndBranch(packet.projectRoot, packet.worktree, packet.branch);
    killSelfForTest();
    // A rerun of a killed pass leaves the physical lease from the worktree this just tore down.
    if (existsSync(taskWorktreeLeasePath(packet.worktree))) {
        releaseTaskWorktreeLease({ worktreePath: packet.worktree, runId: packet.runId });
    }
    const worktree = createFreshTaskWorktree(packet.taskNumber, packet.runId, packet.projectRoot);
    updateCurrentTaskRun(packet.taskNumber, packet.runId, { worktree, leaseRunId: packet.runId }, packet.projectRoot);
    clearResetIntent(packet.worktree);
    return { ...packet, box: "RESET_WORKTREE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, worktree, docsMode: "AUTOGEN" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
