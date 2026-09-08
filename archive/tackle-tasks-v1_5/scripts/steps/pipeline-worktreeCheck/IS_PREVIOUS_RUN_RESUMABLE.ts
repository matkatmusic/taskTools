// IS_PREVIOUS_RUN_RESUMABLE, from pipeline-worktreeCheck.mmd. Mutating: establishes lease ownership.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { isTaskRunResumable } from "../../tackle-tasks/isTaskRunResumable.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket & { next: string } {
    const packet = JSON.parse(input) as WorktreeCheckPacket;
    const { resumable } = isTaskRunResumable(packet.taskNumber, packet.worktree, packet.runId, packet.projectRoot);
    if (resumable) {
        return { ...packet, box: "IS_PREVIOUS_RUN_RESUMABLE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "DOES_FENCE_COVER_WORKTREE" };
    }
    return {
        ...packet,
        box: "IS_PREVIOUS_RUN_RESUMABLE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        exitType: "not-resumable",
        exitNote: "a safe worktree holds work no run recorded a stopping point for",
        next: "FAILURES_EXIT",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
