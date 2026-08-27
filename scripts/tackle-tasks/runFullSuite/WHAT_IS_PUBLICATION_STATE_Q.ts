// WHAT_IS_PUBLICATION_STATE_Q, from pipeline-runFullSuite.mmd. merged, no-op, and root-merged-but-not-closed are LANDED.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type PublicationState = "ALL LANDED" | "SOME LANDED" | "NONE LANDED";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    exitType: string;
    exitNote: string;
    state: PublicationState;
};

const PARTIAL_EXIT_NOTE = "some layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.";

// SOME LANDED never retries; NONE LANDED is the only retryable case.
function nextBoxFor(state: PublicationState): string {
    if (state === "ALL LANDED") return "pipeline-mergeSucceededExit.mmd::MERGE_SUCCEEDED_EXIT";
    if (state === "NONE LANDED") return "ARE_2_MERGE_ATTEMPTS_DONE_Q";
    return "pipeline-failuresExit.mmd::FAILURES_EXIT";
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const partial = packet.state === "SOME LANDED";
    return {
        ...packet,
        box: "WHAT_IS_PUBLICATION_STATE_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: nextBoxFor(packet.state),
        exitType: partial ? "partially-published" : packet.exitType,
        exitNote: partial ? PARTIAL_EXIT_NOTE : packet.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
