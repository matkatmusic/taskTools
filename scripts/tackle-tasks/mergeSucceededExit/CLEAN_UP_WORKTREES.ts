// CLEAN_UP_WORKTREES, from pipeline-mergeSucceededExit.mmd "clean up worktrees, leases, persistence refs and the source lock". Mutating: also releases the source lock.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { cleanupTaskWorktree } from "../shared/cleanupTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, releaseSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { writeTailCursor } from "../shared/taskRunState.ts";

export type CleanUpWorktreesInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktree: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CleanUpWorktreesInput;
    const owner = buildLockOwner(packet.runId, packet.taskNumber);
    writeTailCursor(
        packet.taskNumber, packet.runId,
        { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input },
        packet.projectRoot,
    );
    // A prior failed attempt's catch (cleanupTaskWorktree.ts:82-85) always releases this lock even
    // though cleanup did not finish, so a retry must be able to reacquire it, not merely refresh it
    // (the same "acquired or already-held-by-me, else throw" shape resumeRun.ts's prepareResume uses).
    const lockOutcome = acquireSourceRepoLock(packet.projectRoot, owner);
    if (lockOutcome.status === "acquired" || lockOutcome.status === "already-held-by-me") {
        const output = cleanupTaskWorktree({
            projectRoot: packet.projectRoot, worktreePath: packet.worktree, taskNumber: packet.taskNumber, runId: packet.runId,
            rootSourceBranch: "staging",
        });
        if (output.retainedArtifacts.length === 0) {
            writeTailCursor(packet.taskNumber, packet.runId, null, packet.projectRoot);
            releaseSourceRepoLock(packet.projectRoot, owner);
        }
        return {
            box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
        };
    }
    throw new Error(`CLEAN_UP_WORKTREES: source repo lock is held by ${lockOutcome.owner}`);
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
