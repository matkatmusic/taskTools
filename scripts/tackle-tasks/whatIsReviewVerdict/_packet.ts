// One shape for every green block between WHAT_IS_REVIEW_VERDICT and its exits, so no edge has a dialect.
export type WhatIsReviewVerdictPacket = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    planFile: string;
    reviewOutputFile: string;
    exitType: string;
    exitNote: string;
};
