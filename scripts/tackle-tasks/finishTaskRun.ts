// The two exit tails — pipeline-failuresExit.mmd and pipeline-mergeSucceededExit.mmd, box by box.
import { readFileSync } from "node:fs";
import { buildClosureNote } from "./buildClosureNote.ts";
import { cleanupTaskWorktree } from "./cleanupTaskWorktree.ts";
import { closeTaskRun } from "./closeTaskRun.ts";
import { taskBranchName } from "./createTaskWorktree.ts";
import { markTaskInactive } from "./markTaskInactive.ts";
import { readPublicationState, type PublicationState } from "./readPublicationState.ts";
import { recordMergeCommits } from "./recordMergeCommits.ts";
import { recordTaskModifiedFiles } from "./recordTaskModifiedFiles.ts";
import { releaseTaskRunHolds } from "./releaseTaskRunHolds.ts";
import { getCurrentTaskRun, updateCurrentTaskRun } from "./taskRunState.ts";
import { writeTaskExitNotes } from "./writeTaskExitNotes.ts";
import { logStepOutput } from "./logStepOutput.ts";

export type FinishTaskRunInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    sourceBranch: string;
    exitType: string;
    exitNote: string;
};

export type FinishTaskRunOutput = {
    exitType: string;
    exitNote: string;
    publicationState: PublicationState | null;
    workLanded: boolean;
    leaseReleased: boolean;
    lockReleased: boolean;
    modifiedFiles: string[];
    closureNote: string | null;
};

// The tail asks git what landed, never the incoming exit type, so a gap failure cannot reopen a merge.
export function finishFailedRun(input: FinishTaskRunInput): FinishTaskRunOutput {
    const { taskNumber, runId, projectRoot, worktree, sourceBranch } = input;
    const publication = readPublicationState({ taskNumber, projectRoot, worktreePath: worktree });
    const workLanded = publication.landed.length > 0;

    // Landed work keeps completed if it is already written, and is never reported as run-failed.
    const alreadyCompleted = getCurrentTaskRun(taskNumber, projectRoot)?.exitType === "completed";
    const landedExitType = alreadyCompleted ? "completed" : "partially-published";
    const exitType = workLanded ? landedExitType : input.exitType;
    writeTaskExitNotes({ taskNumber, runId, projectRoot, exitType, exitNote: input.exitNote });
    if (workLanded) updateCurrentTaskRun(taskNumber, runId, { cleanupIncomplete: true }, projectRoot);

    const { modifiedFiles } = recordTaskModifiedFiles({ taskNumber, runId, projectRoot, worktree, sourceBranch });
    const holds = releaseTaskRunHolds({
        taskNumber, runId, projectRoot, worktree,
        branchName: taskBranchName(taskNumber),
        stepId: "failures-exit",
    });
    markTaskInactive({ taskNumber, runId, projectRoot });

    return {
        exitType,
        exitNote: input.exitNote,
        publicationState: publication.state,
        workLanded,
        leaseReleased: holds.leaseReleased,
        lockReleased: holds.lockReleased,
        modifiedFiles,
        closureNote: null,
    };
}

// completed is the point of no return, written before any release, and this tail alone removes a worktree.
export function finishCompletedRun(input: FinishTaskRunInput): FinishTaskRunOutput {
    const { taskNumber, runId, projectRoot, worktree, sourceBranch } = input;
    const publication = readPublicationState({ taskNumber, projectRoot, worktreePath: worktree });
    recordMergeCommits({ projectRoot, taskNumber, runId, commits: publication.commits });
    writeTaskExitNotes({ taskNumber, runId, projectRoot, exitType: "completed", exitNote: input.exitNote });
    const { modifiedFiles } = recordTaskModifiedFiles({ taskNumber, runId, projectRoot, worktree, sourceBranch });
    cleanupTaskWorktree({ projectRoot, worktreePath: worktree, taskNumber, runId });
    const { closureNote } = buildClosureNote({ taskNumber, runId, projectRoot });
    markTaskInactive({ taskNumber, runId, projectRoot });
    closeTaskRun({ taskNumber, runId, projectRoot, closureNote, stepId: "merge-succeeded-exit" });

    return {
        exitType: "completed",
        exitNote: input.exitNote,
        publicationState: publication.state,
        workLanded: true,
        leaseReleased: true,
        lockReleased: true,
        modifiedFiles,
        closureNote,
    };
}

export function finishTaskRun(input: FinishTaskRunInput): FinishTaskRunOutput {
    return input.exitType === "completed" ? finishCompletedRun(input) : finishFailedRun(input);
}

const FINISH_TASK_RUN_SOURCE = "scripts/tackle-tasks/finishTaskRun.ts:94: finishTaskRun";

if (process.argv[1]?.endsWith("finishTaskRun.ts")) {
    const payloadText = readFileSync(0, "utf8");
    const input = JSON.parse(payloadText) as FinishTaskRunInput & { boxId?: string };
    const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId: input.runId };
    const boxId = input.boxId ?? "finishTaskRun";
    const command = `node ${process.argv[1]} <<'TTFINISH'\n${payloadText}\nTTFINISH`;

    try {
        const output = finishTaskRun(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: FINISH_TASK_RUN_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: FINISH_TASK_RUN_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
