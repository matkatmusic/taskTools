// Which green boxes may be retried after a lost agent result. No CLI: this is a table.
export type GreenBoxCategory = "read-only" | "mutating" | "maintenance-mutating";

// A read-only box mutates nothing, so a lost result is answered by running it again.
export const READ_ONLY_RETRY_LIMIT = 3;

// Every script the workflow dispatches, keyed by its file basename without the extension.  Both test boxes are "mutating" because they write their durable decision to task.run before they print stdout [a4 2]. recoverSourceRepoLock is run by an operator, never by the workflow, so agent-result reconciliation does not apply to it.
export const GREEN_BOX_POLICY: Record<string, GreenBoxCategory> = {
    advanceTaskRebase: "mutating",
    AgentPromptEmitter: "read-only",
    applyPlanAmendments: "mutating",
    buildClosureNote: "read-only",
    checkTaskFileFence: "read-only",
    checkTaskWorktreeSafe: "read-only",
    isTaskActive: "mutating",
    cleanupTaskWorktree: "mutating",
    closeTaskRun: "mutating",
    commitTaskWork: "mutating",
    createTaskWorktree: "mutating",
    doesTaskWorktreeExist: "read-only",
    generateTaskDocs: "mutating",
    initTaskSubmodules: "mutating",
    isTaskBlocked: "read-only",
    isTaskNumberValid: "read-only",
    isTaskRunResumable: "mutating",
    markTaskInactive: "mutating",
    mergeTaskWorktree: "mutating",
    rebaseTaskWorktree: "mutating",
    reconcileStep: "read-only",
    recordImplementationNotes: "mutating",
    recordMergeCommits: "mutating",
    recordTaskModifiedFiles: "mutating",
    recoverSourceRepoLock: "maintenance-mutating",
    releaseTaskRunHolds: "mutating",
    resetTaskWorktree: "mutating",
    resolveTaskRun: "read-only",
    runFullSuite: "mutating",
    runTaskTests: "mutating",
    updateTaskDocs: "mutating",
    validateCodexReview: "read-only",
    validatePlanFile: "read-only",
    writeTaskExitNotes: "mutating",
};

// Libraries the pipeline imports but never dispatches as a box. Every new script must be listed.
export const NON_DISPATCHED_SCRIPTS: string[] = [
    "AmendTestsBodyEmitter",
    "CodexReviewBodyEmitter",
    "CodexTestReviewBodyEmitter",
    "FixCodebaseBodyEmitter",
    "FixConflictsBodyEmitter",
    "ImplementTestPipelineEmitter",
    "PlannerBodyEmitter",
    "PlanningPipelineEmitter",
    "PreambleDataEmitter",
    "RebaseMergePipelineEmitter",
    "SkillBodyEmitter",
    "SuiteFixBodyEmitter",
    "WorkflowResultCodes",
    "emitPipelineOutput",
    "generateTaskWorkflow",
    "greenBoxPolicy",
    "inputPaths",
    "occurrences",
    "planArtifacts",
    "sourceRepoLock",
    "stepPipeline",
    "taskRunState",
    "validateActiveTaskReceipt",
    "writeTaskBrief",
];

export function getGreenBoxCategory(scriptName: string): GreenBoxCategory {
    const category = GREEN_BOX_POLICY[scriptName];
    if (category === undefined) throw new Error(`no green box policy entry for "${scriptName}"`);
    return category;
}

// The workflow dispatches these; the maintenance script is deliberately absent from that set.
export function getMutatingWorkflowScripts(): string[] {
    return Object.keys(GREEN_BOX_POLICY).filter((name) => GREEN_BOX_POLICY[name] === "mutating").sort();
}
