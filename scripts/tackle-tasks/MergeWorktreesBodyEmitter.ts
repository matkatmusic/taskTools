// Sole home of the merge-worktrees prompt, the merge and publication-read boxes in plans/diagram/pipeline-merge.mmd.
import { fileURLToPath } from "node:url";

// The receipt those boxes hand back.
export type MergeWorktreesReceipt = {
    state: string;
};

const MERGE_TASK_WORKTREE_PATH = fileURLToPath(new URL("./mergeTaskWorktree.ts", import.meta.url));
const READ_PUBLICATION_STATE_PATH = fileURLToPath(new URL("./readPublicationState.ts", import.meta.url));

export type MergeWorktreesPromptInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    sourceBranch: string;
};

export function mergeWorktreesPrompt(input: MergeWorktreesPromptInput): string {
    // Serialized, never interpolated, and delivered on quoted-heredoc stdin.
    const mergePayload = JSON.stringify({
        projectRoot: input.projectRoot,
        worktreePath: input.worktree,
        taskNumber: input.taskNumber,
        runId: input.runId,
        rootSourceBranch: input.sourceBranch,
    });
    const readPayload = JSON.stringify({
        taskNumber: input.taskNumber,
        projectRoot: input.projectRoot,
        worktreePath: input.worktree,
    });
    return `Run these two commands with Bash, in this order, exactly as written.

First, merge every layer:
node ${MERGE_TASK_WORKTREE_PATH} <<'TTMERGE'
${mergePayload}
TTMERGE

Run the second command even when the first one reports a failure.
Each layer writes its own merge ref as it lands, so only the refs say what landed.

Second, read the publication state:
node ${READ_PUBLICATION_STATE_PATH} <<'TTREAD'
${readPayload}
TTREAD

Return the second command's JSON object verbatim.

Run nothing else. Edit nothing. Never merge, reset or push anything by hand.

If the second command fails, say so plainly and return nothing else.
That is an operational failure, and a later box owns it.`;
}
