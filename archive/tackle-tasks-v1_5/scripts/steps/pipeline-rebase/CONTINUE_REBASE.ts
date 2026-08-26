// CONTINUE_REBASE, from pipeline-rebase.mmd. Mutating: reuses advanceTaskRebase to continue the stopped layer's live rebase and resume the deepest-first walk.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { advanceTaskRebase } from "../../tackle-tasks/advanceTaskRebase.ts";
import type { RebasePacket } from "./packet.ts";

type IncomingPacket = RebasePacket & { next?: string };

// advanceTaskRebase refreshes the lock's heartbeat itself before touching anything.
export function main(input: string): RebasePacket {
    const { next: _next, ...packet } = JSON.parse(input) as IncomingPacket;

    const outcome = advanceTaskRebase({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: packet.stepId,
        rootSourceBranch: packet.rootSourceBranch,
        stoppedAt: { occurrenceId: packet.stoppedOccurrenceId, checkoutPath: packet.stoppedCheckoutPath },
    });

    return {
        ...packet,
        box: "CONTINUE_REBASE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        conflicted: outcome.conflicted,
        stoppedOccurrenceId: outcome.stoppedAt?.occurrenceId ?? "",
        stoppedCheckoutPath: outcome.stoppedAt?.checkoutPath ?? "",
        conflictedFilePaths: outcome.conflictedFilePaths,
        finished: outcome.finished,
        failureReason: outcome.failureReason ?? "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
