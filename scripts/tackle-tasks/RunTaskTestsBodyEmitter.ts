// Sole home of the run-task-tests prompt, the "run task tests" box in plans/diagram/pipeline-taskTests.mmd.
import type { PreparedTask } from "./preparedTask.ts";

// The receipt that box hands back.
export type RunTaskTestsReceipt = {
    passed: boolean;
};

// Double-quoted for the run-task-tests hook's parser, so a worktree path with spaces survives.
const skillArgs = (values: (string | number)[]) => values.map((value) => `"${value}"`).join(" ");

export function runTaskTestsPrompt(t: PreparedTask, runId: string, sourceBranch: string): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    return `Invoke the following skill verbatim:
\`\`\`
/run-task-tests ${skillArgs([t.number, runId, root, sourceBranch, t.taskStateRoot])}
\`\`\`

Return the skill's output verbatim.

If the skill puts no verdict into your context, say so plainly and return nothing else.
That is an operational failure, and a later box owns it.`;
}
