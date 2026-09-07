// REBASE_RESUMED_WORKTREE_ONTO_STAGING, from pipeline-preambleStatusCheck.mmd. Mutating: rebases a resumed worktree when staging has moved since it was cut.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { rebaseTaskWorktree } from "../shared/rebaseTaskWorktree.ts";
import { buildLockOwner, releaseSourceRepoLock } from "../shared/sourceRepoLock.ts";
import type { EntryPacket } from "./_packet.ts";

const STAGING = "staging";
const REBASE_STEP_ID = "rebase-resumed";
const RETURN_TO = "pipeline-preambleStatusCheck.mmd::DOES_FENCE_COVER_WORKTREE_Q";

export type RebaseResumedPacket = EntryPacket & {
    rebased: boolean;
    conflicted: boolean;
    stoppedOccurrenceId: string;
    stoppedCheckoutPath: string;
    conflictedFilePaths: string[];
    failureReason: string;
    returnTo: string;
};

// The whole test: staging's tip is an ancestor of the worktree branch, or it is not.
function isStagingAncestorOfWorktree(worktree: string): boolean {
    const result = spawnSync("git", ["-C", worktree, "merge-base", "--is-ancestor", STAGING, "HEAD"], { encoding: "utf8" });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error(`git merge-base --is-ancestor failed in ${worktree}: ${result.stderr}`);
}

export async function main(input: string): Promise<RebaseResumedPacket & { next: string }> {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const notRebased = {
        ...packet, box: "REBASE_RESUMED_WORKTREE_ONTO_STAGING", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        rebased: false, conflicted: false, stoppedOccurrenceId: "", stoppedCheckoutPath: "", conflictedFilePaths: [], failureReason: "", returnTo: "",
    };
    if (isStagingAncestorOfWorktree(packet.worktree)) {
        return { ...notRebased, next: "DOES_FENCE_COVER_WORKTREE_Q" };
    }

    const outcome = await rebaseTaskWorktree({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: REBASE_STEP_ID,
        rootSourceBranch: STAGING,
    });
    if (outcome.lock !== "acquired") {
        throw new Error(`REBASE_RESUMED_WORKTREE_ONTO_STAGING: source repo lock is not held (${outcome.lock})`);
    }
    if (outcome.failureReason !== null) {
        throw new Error(`REBASE_RESUMED_WORKTREE_ONTO_STAGING: rebase failed: ${outcome.failureReason}`);
    }
    if (outcome.conflicted) {
        // The lock stays held: FIX_CONFLICTS expects it, and IS_REBASE_FINISHED_Q releases it on the way back.
        return {
            ...notRebased, rebased: true, conflicted: true,
            stoppedOccurrenceId: outcome.stoppedAt?.occurrenceId ?? "",
            stoppedCheckoutPath: outcome.stoppedAt?.checkoutPath ?? "",
            conflictedFilePaths: outcome.conflictedFilePaths,
            returnTo: RETURN_TO,
            next: "pipeline-commitMergeConflictFixIfNeeded.mmd::ARE_2_CONFLICT_FIXES_DONE_Q",
        };
    }
    releaseSourceRepoLock(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
    return { ...notRebased, rebased: true, next: "DOES_FENCE_COVER_WORKTREE_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    main(process.argv[2] ?? "").then((result) => console.log(JSON.stringify(result)));
