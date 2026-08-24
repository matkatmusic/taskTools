// CREATE_WORKTREE, from pipeline-worktreeCheck.mmd. Mutating: creates a real git worktree.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { createFreshTaskWorktree } from "./_createFreshTaskWorktree.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket {
    // The incoming packet may carry a decision predecessor's `next`; this box has one successor.
    const { next: _next, ...packet } = JSON.parse(input) as WorktreeCheckPacket & { next?: string };
    const worktree = createFreshTaskWorktree(packet.taskNumber, packet.runId, packet.projectRoot);
    return {
        ...packet,
        box: "CREATE_WORKTREE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        worktree,
        docsMode: "AUTOGEN",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
