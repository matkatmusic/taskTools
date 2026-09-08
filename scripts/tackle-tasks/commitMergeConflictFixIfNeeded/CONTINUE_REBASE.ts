// CONTINUE_REBASE, from pipeline-rebase.mmd. Mutating: continues the stopped layer's live rebase and resumes the deepest-first walk.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { advanceTaskRebase } from "../shared/advanceTaskRebase.ts";
import type { CommitMergeConflictFixIfNeededPacket } from "./_packet.ts";

function baseBranch(projectRoot: string): string {
    // return execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return "staging";
}

// advanceTaskRebase refreshes the lock's heartbeat itself before touching anything.
export function main(input: string): CommitMergeConflictFixIfNeededPacket {
    const packet = JSON.parse(input) as CommitMergeConflictFixIfNeededPacket;

    const outcome = advanceTaskRebase({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: "continue-rebase",
        rootSourceBranch: baseBranch(packet.projectRoot),
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
