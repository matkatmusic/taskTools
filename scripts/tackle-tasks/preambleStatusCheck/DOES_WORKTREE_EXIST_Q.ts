// DOES_WORKTREE_EXIST_Q, from pipeline-preambleStatusCheck.mmd. "does a worktree exist?"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { doesTaskWorktreeExist } from "../shared/doesTaskWorktreeExist.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const { exists, worktree } = doesTaskWorktreeExist(packet.taskNumber, packet.projectRoot);
    return {
        ...packet,
        box: "DOES_WORKTREE_EXIST_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        worktree: exists ? (worktree as string) : "",
        next: exists ? "IS_WORKTREE_SAFE_TO_USE_Q" : "CREATE_WORKTREE",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
