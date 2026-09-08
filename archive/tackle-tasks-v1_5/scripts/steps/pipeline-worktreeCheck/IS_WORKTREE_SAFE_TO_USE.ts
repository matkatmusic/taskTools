// IS_WORKTREE_SAFE_TO_USE, from pipeline-worktreeCheck.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { checkTaskWorktreeSafe } from "../../tackle-tasks/checkTaskWorktreeSafe.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket & { next: string } {
    const packet = JSON.parse(input) as WorktreeCheckPacket;
    const { safe } = checkTaskWorktreeSafe(packet.taskNumber, packet.worktree);
    return {
        ...packet,
        box: "IS_WORKTREE_SAFE_TO_USE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: safe ? "IS_PREVIOUS_RUN_RESUMABLE" : "TAKE_WORKTREE_LEASE_BEFORE_RESET",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
