// One shape for every green block between WHAT_DID_THE_PLANNER_RETURN and its exits, so no edge has a dialect.
export type WhatDidThePlannerReturnPacket = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    docsMode: string;
    planFile: string;
    exitType: string;
    exitNote: string;
    outcome: "PLAN" | "CLARIFY";
    clarifyRequest: string;
};
