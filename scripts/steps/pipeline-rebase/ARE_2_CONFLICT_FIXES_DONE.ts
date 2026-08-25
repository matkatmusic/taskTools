// ARE_2_CONFLICT_FIXES_DONE, from pipeline-rebase.mmd. Mutating: raises the persisted
// conflict-fix attempt counter (taskRunState.ts) each time it sends another fix to the agent.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getAttemptCount, raiseAttemptCount, MAX_ATTEMPTS } from "../../tackle-tasks/taskRunState.ts";
import { refreshLockHeartbeat, type RebasePacket } from "./packet.ts";

const CONFLICT_FIX_COUNTER = "pipeline-rebase-conflict-fix";

export function main(input: string): RebasePacket & { next: string } {
    const packet = JSON.parse(input) as RebasePacket;
    refreshLockHeartbeat(packet.projectRoot, packet.runId, packet.taskNumber);

    const attemptsSoFar = getAttemptCount(packet.taskNumber, CONFLICT_FIX_COUNTER, packet.projectRoot);
    if (attemptsSoFar >= MAX_ATTEMPTS) {
        return {
            ...packet,
            box: "ARE_2_CONFLICT_FIXES_DONE",
            scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            next: "EXIT_WORKFLOW_REBASE",
            exitType: "rebase-stuck",
            exitNote: "the rebase did not advance after 2 conflict fixes",
        };
    }

    raiseAttemptCount(packet.taskNumber, packet.runId, CONFLICT_FIX_COUNTER, packet.projectRoot);
    return { ...packet, box: "ARE_2_CONFLICT_FIXES_DONE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "FIX_CONFLICTS" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
