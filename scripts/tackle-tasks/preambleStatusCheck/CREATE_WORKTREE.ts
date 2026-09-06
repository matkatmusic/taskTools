// CREATE_WORKTREE, from pipeline-preambleStatusCheck.mmd. Mutating: creates a real git worktree. "create a worktree"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { createFreshTaskWorktree } from "../shared/_createFreshTaskWorktree.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const worktree = createFreshTaskWorktree(packet.taskNumber, packet.runId, packet.projectRoot);
    return { ...packet, box: "CREATE_WORKTREE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, worktree };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
