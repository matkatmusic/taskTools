// One shape for every green block in pipeline-rebase.mmd, so no edge has a dialect.
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";

export type RebasePacket = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    exitType: string;
    exitNote: string;
    conflicted: boolean;
    stoppedOccurrenceId: string;
    stoppedCheckoutPath: string;
    conflictedFilePaths: string[];
    failureReason: string;
};

// Diagram rule: a mutating box in this pipeline refreshes the source lock's heartbeat.
export function refreshLockHeartbeat(projectRoot: string, runId: string, taskNumber: number): void {
    refreshOwnedSourceRepoLockOrThrow(projectRoot, buildLockOwner(runId, taskNumber));
}
