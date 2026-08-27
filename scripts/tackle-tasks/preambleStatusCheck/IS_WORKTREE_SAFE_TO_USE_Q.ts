// IS_WORKTREE_SAFE_TO_USE_Q, from pipeline-preambleStatusCheck.mmd. "is the worktree safe to use?"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { checkTaskWorktreeSafe } from "../shared/checkTaskWorktreeSafe.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const { safe } = checkTaskWorktreeSafe(packet.taskNumber, packet.worktree);
    return {
        ...packet,
        box: "IS_WORKTREE_SAFE_TO_USE_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: safe ? "IS_PREVIOUS_RUN_RESUMABLE_Q" : "TAKE_WORKTREE_LEASE_BEFORE_RESET",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
