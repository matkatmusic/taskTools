// One shape for every green block between RUN_FULL_SUITE and its exits, so no edge has a dialect.
export type RunFullSuitePacket = {
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
