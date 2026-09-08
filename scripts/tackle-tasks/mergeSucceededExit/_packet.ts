// Shared packet shape carried through every pipeline-mergeSucceededExit.mmd block.
export type MergeSucceededExitPacket = {
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
