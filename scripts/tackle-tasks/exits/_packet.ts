// One shape for every exit-path block: FAILURES_EXIT, REPORT_ONLY_EXIT, and STOP.
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
};
