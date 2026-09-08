// Shared packet shape carried box-to-box across pipeline-rebase.mmd. An unused field rides as "", [], or false.
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../../tackle-tasks/sourceRepoLock.ts";

export type RebasePacket = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    stepId: string;
    rootSourceBranch: string;
    landedOccurrenceIds: string[];
    suiteFixAttempts: number;
    conflicted: boolean;
    stoppedOccurrenceId: string;
    stoppedCheckoutPath: string;
    conflictedFilePaths: string[];
    finished: boolean;
    failureReason: string;
    exitType: string;
    exitNote: string;
};

// Diagram rule: every box in this pipeline refreshes the source lock's heartbeat.
export function refreshLockHeartbeat(projectRoot: string, runId: string, taskNumber: number): void {
    refreshOwnedSourceRepoLockOrThrow(projectRoot, buildLockOwner(runId, taskNumber));
}
