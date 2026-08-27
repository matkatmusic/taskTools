// One shape for every green block in reportOnlyExit and the STOP shared by all three exit diagrams.
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
