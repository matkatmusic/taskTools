// The planning sub-pipeline (plans/diagram/pipeline-planning.mmd).
//
// It ends on the "finished plan" receipt, which carries the accepted plan file forward.
export type FinishedPlanReceipt = {
    planFile: string;
};
