// The body for the "fix the conflicts" agent box (plans/diagram/pipeline-rebaseMerge.mmd).
//
// The receipt that box hands back.
export type ConflictFixReceipt = {
    resolved: boolean;
    unresolvedPaths: string[];
};
