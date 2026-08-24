// TAKE_WORKTREE_LEASE, from pipeline-worktreeCheck.mmd. Mutating: records lease ownership in task state.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { updateCurrentTaskRun } from "../../tackle-tasks/taskRunState.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket & { next: string } {
    const packet = JSON.parse(input) as WorktreeCheckPacket;
    updateCurrentTaskRun(
        packet.taskNumber, packet.runId,
        { worktree: packet.worktree, leaseRunId: packet.runId },
        packet.projectRoot,
    );
    return { ...packet, box: "TAKE_WORKTREE_LEASE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "INIT_SUBMODULES_RECURSIVELY" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
