// RESET_WORKTREE, from pipeline-worktreeCheck.mmd. Mutating: tears down and recreates the worktree.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { deleteTaskMergePersistence, removeWorktreeAndBranch } from "../../mergeTaskWorktrees.ts";
import { updateCurrentTaskRun } from "../../tackle-tasks/taskRunState.ts";
import { createFreshTaskWorktree } from "./_createFreshTaskWorktree.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket & { next: string } {
    const packet = JSON.parse(input) as WorktreeCheckPacket;
    deleteTaskMergePersistence(packet.projectRoot, packet.branch);
    removeWorktreeAndBranch(packet.projectRoot, packet.worktree, packet.branch);

    const worktree = createFreshTaskWorktree(packet.taskNumber, packet.runId, packet.projectRoot);
    updateCurrentTaskRun(packet.taskNumber, packet.runId, { worktree, leaseRunId: packet.runId }, packet.projectRoot);

    return { ...packet, box: "RESET_WORKTREE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "INIT_SUBMODULES_RECURSIVELY", worktree, docsMode: "AUTOGEN" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
