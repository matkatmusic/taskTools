// One shape for every block in the lockSourceRepo diagram, so no edge has a dialect.
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
    lockWaitStartedAt: string;
};
