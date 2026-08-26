// One shape for every green block between COMMIT_IMPLEMENTATION_IF_NEEDED and its exits, so no edge has a dialect.
export type CommitImplementationIfNeededPacket = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    exitType: string;
    exitNote: string;
    message: string;
    additionalData: Record<string, unknown>;
};
