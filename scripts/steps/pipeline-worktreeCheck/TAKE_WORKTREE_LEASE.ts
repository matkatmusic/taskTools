// TAKE_WORKTREE_LEASE, from pipeline-worktreeCheck.mmd. Mutating: records lease ownership in task state.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { updateCurrentTaskRun } from "../../tackle-tasks/taskRunState.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket {
    // The incoming packet may carry a decision predecessor's `next`; this box has one successor.
    const { next: _next, ...packet } = JSON.parse(input) as WorktreeCheckPacket & { next?: string };
    updateCurrentTaskRun(
        packet.taskNumber, packet.runId,
        { worktree: packet.worktree, leaseRunId: packet.runId },
        packet.projectRoot,
    );
    return { ...packet, box: "TAKE_WORKTREE_LEASE", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
