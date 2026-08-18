// Sole home of the finish-run prompt, the two exit tails in plans/diagram/pipeline-failuresExit.mmd and pipeline-mergeSucceededExit.mmd.
import { fileURLToPath } from "node:url";

// The receipt those tails hand back.
export type FinishRunReceipt = {
    exitType: string;
    workLanded: boolean;
    publicationState: string | null;
    leaseReleased: boolean;
    lockReleased: boolean;
    closureNote: string | null;
};

const FINISH_TASK_RUN_PATH = fileURLToPath(new URL("./finishTaskRun.ts", import.meta.url));

export type FinishRunPromptInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    sourceBranch: string;
    exitType: string;
    exitNote: string;
};

export function finishRunPrompt(input: FinishRunPromptInput): string {
    // Serialized, never interpolated, and delivered on quoted-heredoc stdin.
    const payload = JSON.stringify({
        taskNumber: input.taskNumber,
        runId: input.runId,
        projectRoot: input.projectRoot,
        worktree: input.worktree,
        sourceBranch: input.sourceBranch,
        exitType: input.exitType,
        exitNote: input.exitNote,
    });
    return `Run this with Bash, exactly as written:
node ${FINISH_TASK_RUN_PATH} <<'TTFINISH'
${payload}
TTFINISH

It prints one JSON object. Return that object verbatim.

Run nothing else. Edit nothing. Do not stage, commit, or clean up anything yourself.

If the command fails, say so plainly and return nothing else.
That is an operational failure, and the run's operator owns it.`;
}
