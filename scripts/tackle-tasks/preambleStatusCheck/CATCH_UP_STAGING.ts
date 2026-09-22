// Q_CATCH_UP_STAGING, from pipeline-preambleStatusCheck.mmd. Runs while the source-repo lock is held; a conflict keeps it held.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { catchUpStaging } from "../../shared/catchUpStaging.ts";
import { buildLockOwner, releaseSourceRepoLock } from "../shared/sourceRepoLock.ts";
import type { EntryPacket } from "./_packet.ts";

// lockWaitStartedAt comes from Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q and is absent on the Q_COMMIT_CATCH_UP_MERGE loop-back.
type Input = EntryPacket & { lockWaitStartedAt?: string; next?: string };

export function main(input: string): EntryPacket & { next: string; repository?: string; worktreePath?: string } {
    // lockWaitStartedAt is dropped here, so LOCK_SOURCE_REPO later starts its own wait clock.
    const { next: _next, lockWaitStartedAt: _lockWaitStartedAt, ...packet } = JSON.parse(input) as Input;
    const conflict = catchUpStaging(packet.projectRoot, packet.taskNumber);
    if (conflict !== null) {
        return {
            ...packet,
            box: "Q_CATCH_UP_STAGING",
            scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            repository: conflict.repository,
            worktreePath: conflict.worktreePath,
            next: "B_FIX_CATCH_UP_CONFLICTS",
        };
    }
    // runId is still "" before B_MARK_TASK_ACTIVE, so this is the owner B_LOCK_STAGING_FOR_CATCH_UP took.
    releaseSourceRepoLock(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
    return { ...packet, box: "Q_CATCH_UP_STAGING", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "B_MARK_TASK_ACTIVE" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
