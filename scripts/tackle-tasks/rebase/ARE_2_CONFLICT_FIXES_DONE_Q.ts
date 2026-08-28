// ARE_2_CONFLICT_FIXES_DONE_Q, from pipeline-rebase.mmd and pipeline-commitMergeConflictFixIfNeeded.mmd. Mutating: raises the conflict-fix attempt counter before sending another fix.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readCheckpoint } from "../shared/checkpoint.ts";
import { getAttemptCount, raiseAttemptCount, MAX_ATTEMPTS } from "../shared/taskRunState.ts";
import { refreshLockHeartbeat, type RebasePacket } from "./_packet.ts";

const CONFLICT_FIX_COUNTER = "pipeline-rebase-conflict-fix";

export function main(input: string): RebasePacket & { next: string } {
    const packet = JSON.parse(input) as RebasePacket;
    refreshLockHeartbeat(packet.projectRoot, packet.runId, packet.taskNumber);

    const attemptsSoFar = getAttemptCount(packet.taskNumber, CONFLICT_FIX_COUNTER, packet.projectRoot);
    if (attemptsSoFar >= MAX_ATTEMPTS) {
        return {
            ...packet,
            box: "ARE_2_CONFLICT_FIXES_DONE_Q",
            scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
            exitType: "rebase-stuck",
            exitNote: "the rebase did not advance after 2 conflict fixes",
        };
    }

    const checkpoint = readCheckpoint(packet.worktree);
    if (checkpoint === null) throw new Error(`ARE_2_CONFLICT_FIXES_DONE_Q: no checkpoint in ${packet.worktree}`);
    raiseAttemptCount(packet.taskNumber, packet.runId, CONFLICT_FIX_COUNTER, checkpoint.passId, packet.projectRoot);
    return { ...packet, box: "ARE_2_CONFLICT_FIXES_DONE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "pipeline-fixConflicts.mmd::FIX_CONFLICTS" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
