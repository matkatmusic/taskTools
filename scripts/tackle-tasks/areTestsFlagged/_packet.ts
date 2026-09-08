// One shape for every green block between ARE_TESTS_FLAGGED and its exits, so no edge has a dialect.
export type AreTestsFlaggedPacket = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    exitType: string;
    exitNote: string;
    flagged: boolean;
    notes: string;
};
