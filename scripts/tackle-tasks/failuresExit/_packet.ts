// One shape for every green block between FAILURES_EXIT and REPORT_EXIT_TYPE_AND_NOTE, so no edge has a dialect.
export type EntryPacket = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    exitType: string;
    exitNote: string;
    publicationState: string;
    modifiedFiles: string[];
    active: boolean;
    endedAt: string;
    leaseReleased: boolean;
    leaseRetained: boolean;
    lockReleased: boolean;
};
