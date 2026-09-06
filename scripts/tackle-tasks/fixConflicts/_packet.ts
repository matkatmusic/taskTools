// The packet FIX_CONFLICTS receives, so its edge into this folder has no dialect.
export type FixConflictsPacket = {
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
    // Set only by REBASE_RESUMED_WORKTREE_ONTO_STAGING: where IS_REBASE_FINISHED_Q routes once the rebase is done.
    returnTo?: string;
};
