// Shared packet shape carried through every pipeline-worktreeCheck.mmd block.
export type WorktreeCheckPacket = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    docsMode: string;
    exitType: string;
    exitNote: string;
};
