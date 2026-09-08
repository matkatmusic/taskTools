// IS_PREVIOUS_RUN_RESUMABLE_Q, from pipeline-preambleStatusCheck.mmd. Mutating: establishes lease ownership. "is the previous run's work resumable? adopt the lease for this run"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { isTaskRunResumable } from "../shared/isTaskRunResumable.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const { resumable } = isTaskRunResumable(packet.taskNumber, packet.worktree, packet.runId, packet.projectRoot);
    if (resumable) {
        return { ...packet, box: "IS_PREVIOUS_RUN_RESUMABLE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "REBASE_RESUMED_WORKTREE_ONTO_STAGING" };
    }
    return {
        ...packet,
        box: "IS_PREVIOUS_RUN_RESUMABLE_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        exitType: "not-resumable",
        exitNote: "a safe worktree holds work no run recorded a stopping point for",
        next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
