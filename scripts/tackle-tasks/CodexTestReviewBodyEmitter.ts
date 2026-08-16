// The body for the "codex reviews tests" agent box (plans/diagram/pipeline-implementTest.mmd).
//
// The receipt that box hands back.
export type TestReviewReceipt = {
    flagged: boolean;
    reviewer: string;
    testReviewFile: string;
};
