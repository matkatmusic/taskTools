// DOES_WORKTREE_EXIST, from pipeline-worktreeCheck.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { doesTaskWorktreeExist } from "../../tackle-tasks/doesTaskWorktreeExist.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket & { next: string } {
    const packet = JSON.parse(input) as WorktreeCheckPacket;
    const { exists, worktree } = doesTaskWorktreeExist(packet.taskNumber, packet.projectRoot);
    return {
        ...packet,
        box: "DOES_WORKTREE_EXIST",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        worktree: exists ? (worktree as string) : "",
        next: exists ? "IS_WORKTREE_SAFE_TO_USE" : "CREATE_WORKTREE",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
