// The rebase-and-merge sub-pipeline (plans/diagram/pipeline-rebaseMerge.mmd).
//
// It ends on the "merge" receipt, emitted only after "did the merge land?" answers YES.
export type MergeReceipt = {
    commits: string[];
    modifiedFiles: string[];
};
