// Whether a phase's caller may keep going. Two codes, because a caller only ever asks one question.
export const WorkflowResultCodes = {
    PROCEED: "PROCEED",
    DO_NOT_PROCEED: "DO_NOT_PROCEED",
} as const;

export type WorkflowResultCode = (typeof WorkflowResultCodes)[keyof typeof WorkflowResultCodes];
