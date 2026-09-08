// The packet CODEX_REVIEWS_TESTS accepts; it hands the same fields on to the agent that runs its prompt.
export type CodexReviewsTestsPacket = {
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
