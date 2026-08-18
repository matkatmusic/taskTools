// Sole home of the continue-rebase prompt, the "continue the rebase" box in plans/diagram/pipeline-rebase.mmd.
import type { PreparedTask } from "./preparedTask.ts";

// The receipt that box hands back.
export type ContinueRebaseReceipt = {
    finished: boolean;
};

// Double-quoted for the continue-rebase hook's parser, so a worktree path with spaces survives.
const skillArgs = (values: (string | number)[]) => values.map((value) => `"${value}"`).join(" ");

export function continueRebasePrompt(t: PreparedTask, runId: string, sourceBranch: string): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    return `Invoke the following skill verbatim:
\`\`\`
/continue-rebase ${skillArgs([t.number, runId, root, sourceBranch, t.taskStateRoot])}
\`\`\`

Return the skill's output verbatim.

If the skill puts no verdict into your context, say so plainly and return nothing else.
That is an operational failure, and a later box owns it.`;
}
