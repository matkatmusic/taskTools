// Sole home of the check-fence prompt, the "did every change stay inside the fence?" box in plans/diagram/pipeline-suite.mmd.
import { fileURLToPath } from "node:url";

// The receipt that box hands back.
export type CheckFenceReceipt = {
    inside: boolean;
    violations: string[];
};

const CHECK_TASK_FILE_FENCE_PATH = fileURLToPath(new URL("./checkTaskFileFence.ts", import.meta.url));

export type CheckFencePromptInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    sourceBranch: string;
};

export function checkFencePrompt(input: CheckFencePromptInput): string {
    // Serialized, never interpolated, and delivered on quoted-heredoc stdin.
    const payload = JSON.stringify({
        projectRoot: input.projectRoot,
        worktreePath: input.worktree,
        taskNumber: input.taskNumber,
        runId: input.runId,
        rootSourceBranch: input.sourceBranch,
    });
    return `Run this with Bash, exactly as written:
node ${CHECK_TASK_FILE_FENCE_PATH} <<'TTFENCE'
${payload}
TTFENCE

It prints one JSON object. Return that object verbatim.

It derives the diff itself. Run nothing else, and edit nothing.

If the command fails, say so plainly and return nothing else.
That is an operational failure, and a later box owns it.`;
}
