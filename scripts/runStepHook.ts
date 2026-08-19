// Runs green pipeline script boxes for /run-step, typed as a prompt or invoked as the skill by an agent.
import { readFileSync } from "node:fs";
import { pipelineGraph, stepAfter } from "./mmdGraph.ts";
import { amendEntryWithCodexNotes } from "./tackle-tasks/amendEntryWithCodexNotes.ts";
import { amendEntryWithFailingTests } from "./tackle-tasks/amendEntryWithFailingTests.ts";
import { buildClosureNote } from "./tackle-tasks/buildClosureNote.ts";
import { cleanupTaskWorktree } from "./tackle-tasks/cleanupTaskWorktree.ts";
import { closeTaskRun } from "./tackle-tasks/closeTaskRun.ts";
import { commitTaskWork } from "./tackle-tasks/commitTaskWork.ts";
import { createTaskWorktree, taskBranchName } from "./tackle-tasks/createTaskWorktree.ts";
import { generateTaskDocs } from "./tackle-tasks/generateTaskDocs.ts";
import { initTaskSubmodules } from "./tackle-tasks/initTaskSubmodules.ts";
import { lockSourceRepo } from "./tackle-tasks/lockSourceRepo.ts";
import { markTaskInactive } from "./tackle-tasks/markTaskInactive.ts";
import { mergeTaskWorktree } from "./tackle-tasks/mergeTaskWorktree.ts";
import { readPublicationState } from "./tackle-tasks/readPublicationState.ts";
import { recordMergeCommits } from "./tackle-tasks/recordMergeCommits.ts";
import { recordPlanReview } from "./tackle-tasks/recordPlanReview.ts";
import { recordTaskModifiedFiles } from "./tackle-tasks/recordTaskModifiedFiles.ts";
import { releaseTaskRunHolds } from "./tackle-tasks/releaseTaskRunHolds.ts";
import { resetTaskWorktree } from "./tackle-tasks/resetTaskWorktree.ts";
import { updateTaskDocs } from "./tackle-tasks/updateTaskDocs.ts";
import { writeClarifyRequest } from "./tackle-tasks/writeClarifyRequest.ts";
import { writeTaskExitNotes } from "./tackle-tasks/writeTaskExitNotes.ts";
import { MAX_ATTEMPTS, claimTask, getAttemptCount, raiseAttemptCount, type TaskCommit } from "./tackle-tasks/taskRunState.ts";

// The five arguments every green box receives, and the only inputs a row may derive from.
type TaskRunIdentity = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
};

type BoxReceipts = Record<string, Record<string, unknown>>;

// A row returns its script's output so a later box in the same call can read it.
type StepTableRow = {
    allowedExtraFieldNames: string[];
    runBoxScript: (identity: TaskRunIdentity, extraFields: Record<string, unknown>, receipts: BoxReceipts) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

/*
  A receipt a row asks for but no earlier box produced is a wiring mistake, not a missing value, so it throws here rather than reaching a script as undefined.
*/
function readReceipt(receipts: BoxReceipts, boxId: string): Record<string, unknown> {
    const receipt = receipts[boxId];
    if (!receipt) throw new Error(`run-step: no receipt from ${boxId}; name it earlier in the same call`);
    return receipt;
}

const STEP_TABLE: Record<string, StepTableRow> = {
    AMEND_ENTRY_WITH_CODEX_NOTES: {
        allowedExtraFieldNames: ["testReview"],
        runBoxScript: (identity, extraFields) => amendEntryWithCodexNotes({
            projectRoot: identity.projectRoot,
            taskNumber: identity.taskNumber,
            review: extraFields.testReview as never,
        }),
    },
    AMEND_ENTRY_WITH_FAILING_TESTS: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => amendEntryWithFailingTests({
            projectRoot: identity.projectRoot,
            taskNumber: identity.taskNumber,
        }),
    },
    ARCHIVE_TASK: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity, extraFields, receipts) => closeTaskRun({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            closureNote: readReceipt(receipts, "BUILD_CLOSURE_NOTE").closureNote as string,
            stepId: "ARCHIVE_TASK",
        }) as unknown as Record<string, unknown>,
    },
    AUTO_GENERATE_DOCS: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => generateTaskDocs(identity.taskNumber, identity.worktree, identity.projectRoot),
    },
    BUILD_CLOSURE_NOTE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => buildClosureNote({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
        }),
    },
    CLEAN_UP_WORKTREES: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => cleanupTaskWorktree({
            projectRoot: identity.projectRoot,
            worktreePath: identity.worktree,
            taskNumber: identity.taskNumber,
            runId: identity.runId,
        }),
    },
    COMMIT_IF_NEEDED: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => commitTaskWork({
            projectRoot: identity.projectRoot,
            worktreePath: identity.worktree,
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            stepId: "COMMIT_IF_NEEDED",
            rootSourceBranch: identity.sourceBranch,
        }),
    },
    CREATE_WORKTREE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => createTaskWorktree(identity.taskNumber, identity.runId, identity.projectRoot),
    },
    INIT_SUBMODULES_RECURSIVELY: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => initTaskSubmodules({
            worktreePath: identity.worktree,
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            stepId: "INIT_SUBMODULES_RECURSIVELY",
        }),
    },
    // Polls for the lock and can wait minutes; lockSourceRepo.ts owns that bound.
    LOCK_SOURCE_REPO: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => lockSourceRepo({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
        }) as unknown as Promise<Record<string, unknown>>,
    },
    MARK_TASK_ACTIVE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => claimTask(identity.taskNumber, identity.runId, identity.projectRoot) as unknown as Record<string, unknown>,
    },
    MARK_TASK_INACTIVE_FAILURE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => markTaskInactive({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
        }),
    },
    MARK_TASK_INACTIVE_SUCCESS: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => markTaskInactive({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
        }),
    },
    MERGE_WORKTREES: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => mergeTaskWorktree({
            projectRoot: identity.projectRoot,
            worktreePath: identity.worktree,
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            rootSourceBranch: identity.sourceBranch,
        }) as unknown as Record<string, unknown>,
    },
    READ_PUBLICATION_STATE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => readPublicationState({
            taskNumber: identity.taskNumber,
            projectRoot: identity.projectRoot,
            worktreePath: identity.worktree,
        }) as unknown as Record<string, unknown>,
    },
    RECORD_MERGE_COMMIT_HASHES: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity, extraFields, receipts) => recordMergeCommits({
            projectRoot: identity.projectRoot,
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            commits: readReceipt(receipts, "MERGE_WORKTREES").commits as TaskCommit[],
        }) as unknown as Record<string, unknown>,
    },
    RECORD_MODIFIED_FILES_FAILURE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => recordTaskModifiedFiles({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            worktree: identity.worktree,
            sourceBranch: identity.sourceBranch,
        }),
    },
    RECORD_MODIFIED_FILES_SUCCESS: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => recordTaskModifiedFiles({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            worktree: identity.worktree,
            sourceBranch: identity.sourceBranch,
        }),
    },
    RELEASE_SOURCE_LOCK: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => releaseTaskRunHolds({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            worktree: identity.worktree,
            branchName: taskBranchName(identity.taskNumber),
            stepId: "RELEASE_SOURCE_LOCK",
        }),
    },
    RELEASE_WORKTREE_LEASE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => releaseTaskRunHolds({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            worktree: identity.worktree,
            branchName: taskBranchName(identity.taskNumber),
            stepId: "RELEASE_WORKTREE_LEASE",
        }),
    },
    RESET_WORKTREE: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => resetTaskWorktree(identity.taskNumber, identity.runId, identity.projectRoot),
    },
    UPDATE_AUTO_GENERATED_DOCS: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => updateTaskDocs(identity.taskNumber, identity.worktree, identity.projectRoot),
    },
    UPDATE_TASK_ENTRY: {
        allowedExtraFieldNames: ["planReview"],
        runBoxScript: (identity, extraFields) => recordPlanReview({
            projectRoot: identity.projectRoot,
            // The convention preparedTask.ts uses, so the caller cannot point this elsewhere.
            planFilePath: `${identity.worktree}/plans/plan.json`,
            taskNumber: identity.taskNumber,
            review: extraFields.planReview as never,
        }),
    },
    WRITE_CLARIFY_REQUEST: {
        allowedExtraFieldNames: ["clarifyRequest"],
        runBoxScript: (identity, extraFields) => writeClarifyRequest({
            projectRoot: identity.projectRoot,
            taskNumber: identity.taskNumber,
            clarifyRequest: extraFields.clarifyRequest as string,
        }),
    },
    WRITE_EXIT_TYPE_AND_NOTE: {
        allowedExtraFieldNames: ["exitType", "exitNote"],
        runBoxScript: (identity, extraFields) => writeTaskExitNotes({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            exitType: extraFields.exitType as string,
            exitNote: extraFields.exitNote as string,
        }),
    },
    WRITE_EXIT_TYPE_COMPLETED: {
        allowedExtraFieldNames: ["exitNote"],
        runBoxScript: (identity, extraFields) => writeTaskExitNotes({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            exitType: "completed",
            exitNote: extraFields.exitNote as string,
        }),
    },
    // rule 10: reopening overwrites completed on the already-ended success tail.
    WRITE_PUBLICATION_OUTCOME: {
        allowedExtraFieldNames: ["exitType", "exitNote"],
        runBoxScript: (identity, extraFields) => writeTaskExitNotes({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            exitType: extraFields.exitType as string,
            exitNote: extraFields.exitNote as string,
            reopen: true,
        }),
    },
};

/*
  Each ARE_2_*_DONE decision guards one retry. Every site in the diagram has the same shape:
  read the count, stop when it reaches the cap, otherwise start another attempt. So a NO is
  what raises the count -- a NO means the next attempt is beginning.
*/
const ATTEMPT_COUNTERS: Record<string, string> = {
    ARE_2_CLARIFY_ROUNDS_DONE: "clarifyRounds",
    ARE_2_CONFLICT_FIXES_DONE: "conflictFixes",
    ARE_2_MERGE_ATTEMPTS_DONE: "mergeAttempts",
    ARE_2_REVIEWS_DONE: "planReviews",
    ARE_2_SUITE_FIXES_DONE: "suiteFixes",
    ARE_2_TEST_FIXES_DONE: "testFixes",
    ARE_2_TEST_REVIEWS_DONE: "testReviews",
};

// The plan review is the one decision that counts the review that just ran, so it raises first.
const RAISES_BEFORE_CHECKING = "ARE_2_REVIEWS_DONE";

function decideStep(identity: TaskRunIdentity, decisionId: string): Record<string, unknown> {
    const counter = ATTEMPT_COUNTERS[decisionId];
    if (!counter) return { ok: false, note: `no evaluator for decision ${decisionId}` };
    if (decisionId === RAISES_BEFORE_CHECKING) {
        const raised = raiseAttemptCount(identity.taskNumber, identity.runId, counter, identity.projectRoot);
        return { ok: true, outcome: raised >= MAX_ATTEMPTS ? "YES" : "NO" };
    }
    if (getAttemptCount(identity.taskNumber, counter, identity.projectRoot) >= MAX_ATTEMPTS) {
        return { ok: true, outcome: "YES" };
    }
    raiseAttemptCount(identity.taskNumber, identity.runId, counter, identity.projectRoot);
    return { ok: true, outcome: "NO" };
}

async function runStepBoxes(identity: TaskRunIdentity, boxIds: string[], extraFields: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Every box's output, keyed by box id, so a later row can read one that ran earlier.
    const receipts: BoxReceipts = {};
    for (const boxId of boxIds) {
        if (!STEP_TABLE[boxId]) return { ok: false, failedBoxId: boxId, note: `unknown box id: ${boxId}`, receipts };
    }
    // Extra fields reach every box in the call, so one box declaring a field sanctions it for the call. A field no named box declares is still refused, which is what keeps the fence.
    const declaredFieldNames = boxIds.flatMap((boxId) => (STEP_TABLE[boxId] as StepTableRow).allowedExtraFieldNames);
    for (const fieldName of Object.keys(extraFields)) {
        if (declaredFieldNames.includes(fieldName)) continue;
        return { ok: false, failedBoxId: boxIds[0], note: `${boxIds[0]} does not accept the extra field ${fieldName}`, receipts };
    }
    for (const boxId of boxIds) {
        receipts[boxId] = await (STEP_TABLE[boxId] as StepTableRow).runBoxScript(identity, extraFields, receipts);
    }
    return { ok: true, receipts };
}

/*
  Runs the named box, then follows the diagram to the next one, and keeps going while the diagram's next node is another box this table can run. It stops on anything else -- an agent box, a pipeline head, a decision, or the workflow's own output boxes -- and names that node, because only the caller can carry the run past it.
*/
async function walkFromStep(identity: TaskRunIdentity, startBoxId: string, extraFields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const receipts: BoxReceipts = {};
    let thisStep = startBoxId;
    while (true) {
        const row = STEP_TABLE[thisStep];
        if (!row) return { ok: false, failedBoxId: thisStep, note: `unknown box id: ${thisStep}`, receipts };
        receipts[thisStep] = await row.runBoxScript(identity, extraFields, receipts);
        const nextStep = stepAfter(pipelineGraph, thisStep);
        if (!STEP_TABLE[nextStep]) return { ok: true, stoppedAt: nextStep, receipts };
        thisStep = nextStep;
    }
}

let payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> };
try {
    payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
    process.exit(0);
}

// Plugin skills reach the hook namespaced, as /taskTools:run-step and taskTools:run-step.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
const input = payload.tool_input ?? {};
const skill = String(input.skill ?? "").replace(/^[\w-]+:/, "");

const args = prompt.startsWith("/run-step ")
    ? prompt.slice("/run-step".length)
    : skill === "run-step"
        ? String(input.args ?? "")
        : "";
// Extra fields ride a quoted heredoc, as emitterPrompt does: a value holding an apostrophe would otherwise split mid-token and be read as a box id.
const heredoc = args.match(/<<'TTPAYLOAD'\n([\s\S]*?)\nTTPAYLOAD/);
// Quoted runs stay whole, so a worktree path with spaces survives.
const tokens = (args.replace(/<<'TTPAYLOAD'[\s\S]*$/, "").match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/s, "$2"));
if (tokens.length === 0) process.exit(0);

const inject = (reason: string) => process.stdout.write(JSON.stringify({
    // Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
    hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: reason },
}) + "\n");

if (tokens.length < 6) {
    inject(`run-step: expected 5 identity arguments and at least one box id, got ${tokens.length}: ${tokens.join(" ")}`);
    process.exit(0);
}

const identity: TaskRunIdentity = {
    taskNumber: Number(tokens[0]),
    runId: String(tokens[1]),
    worktree: String(tokens[2]),
    sourceBranch: String(tokens[3]),
    projectRoot: String(tokens[4]),
};

const extraFields = heredoc ? JSON.parse(heredoc[1] as string) : {};
const boxIds = tokens.slice(5);

let result: Record<string, unknown>;
try {
    result = boxIds[0] === "--decide"
        ? decideStep(identity, String(boxIds[1]))
        : boxIds[0] === "--walk"
            ? await walkFromStep(identity, String(boxIds[1]), extraFields)
            : await runStepBoxes(identity, boxIds, extraFields);
} catch (error) {
    result = { ok: false, failedBoxId: boxIds[0], note: String((error as Error)?.message ?? error) };
}
inject(JSON.stringify(result));
