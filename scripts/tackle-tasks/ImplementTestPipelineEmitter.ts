// The implement-and-test sub-pipeline (plans/diagram/pipeline-implementTest.mmd).
//
// It ends on the "finished implementation" receipt, emitted only once the source repo is locked.
import type { LockOwner } from "./sourceRepoLock.ts";

export type FinishedImplementationReceipt = {
    implementationNotesFile: string;
    sourceRepoLock: LockOwner;
};
