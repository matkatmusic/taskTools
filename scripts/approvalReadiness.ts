// approvalReadiness.ts: gates readyForApproval on task/ownership/typecheck/sync checks, green test receipts, and per-group reviewer exercise methods.

export type TaskCompletionState = "done" | "partial" | "blocked" | "needs-clarification";

export interface SelectedTaskStatus {
    taskId: string | number;
    state: TaskCompletionState;
}

export interface OwnershipCheckOutcome {
    passed: boolean;
}

export interface TypecheckOutcome {
    passed: boolean;
}

export interface OccurrenceConvergenceOutcome {
    converged: boolean;
}

export interface TestReceipt {
    groupId: string;
    status: "green" | "red";
}

export type ExerciseMethod =
    | { kind: "url"; url: string }
    | { kind: "command"; command: string; workingDirectory: string }
    | { kind: "note"; text: string };

export interface GroupReviewResult {
    groupId: string;
    methods: ExerciseMethod[];
}

export interface ApprovalReadinessInput {
    groupIds: string[];
    selectedTasks: SelectedTaskStatus[];
    ownership: OwnershipCheckOutcome;
    typecheck: TypecheckOutcome;
    occurrenceConvergence: OccurrenceConvergenceOutcome;
    testReceipts: TestReceipt[];
    groupReviews: GroupReviewResult[];
}

export type ApprovalBlockReason =
    | "partial"
    | "blocked"
    | "clarification"
    | "ownership"
    | "typecheck"
    | "sync"
    | "test"
    | "missing-review"
    | "non-actionable-review";

export interface ApprovalReadinessResult {
    readyForApproval: boolean;
    blockedBy: ApprovalBlockReason[];
}

export interface GroupExerciseFacts {
    groupId: string;
    workingDirectory: string;
    liveServerUrl?: string;
    verificationCommand?: string;
}

export function isActionableExerciseMethod(method: ExerciseMethod): boolean {
    if (method.kind === "url") return method.url !== "";
    if (method.kind === "command") return method.command !== "" && method.workingDirectory !== "";
    return false;
}

export function reviewGroupExerciseMethod(facts: GroupExerciseFacts): GroupReviewResult {
    const methods: ExerciseMethod[] = [];
    if (facts.liveServerUrl) methods.push({ kind: "url", url: facts.liveServerUrl });
    if (facts.verificationCommand) {
        methods.push({ kind: "command", command: facts.verificationCommand, workingDirectory: facts.workingDirectory });
    }
    if (methods.length === 0) {
        methods.push({ kind: "note", text: "no actionable exercise method available" });
    }
    return { groupId: facts.groupId, methods };
}

export function assessApprovalReadiness(input: ApprovalReadinessInput): ApprovalReadinessResult {
    const blockedBy: ApprovalBlockReason[] = [];

    if (input.selectedTasks.some((task) => task.state === "partial")) blockedBy.push("partial");
    if (input.selectedTasks.some((task) => task.state === "blocked")) blockedBy.push("blocked");
    if (input.selectedTasks.some((task) => task.state === "needs-clarification")) blockedBy.push("clarification");
    if (!input.ownership.passed) blockedBy.push("ownership");
    if (!input.typecheck.passed) blockedBy.push("typecheck");
    if (!input.occurrenceConvergence.converged) blockedBy.push("sync");
    if (input.testReceipts.length === 0 || input.testReceipts.some((receipt) => receipt.status === "red")) {
        blockedBy.push("test");
    }

    let missingReview = false;
    let nonActionableReview = false;
    for (const groupId of input.groupIds) {
        const review = input.groupReviews.find((candidate) => candidate.groupId === groupId);
        if (!review) {
            missingReview = true;
            continue;
        }
        if (!review.methods.some(isActionableExerciseMethod)) nonActionableReview = true;
    }
    if (missingReview) blockedBy.push("missing-review");
    if (nonActionableReview) blockedBy.push("non-actionable-review");

    return { readyForApproval: blockedBy.length === 0, blockedBy };
}
