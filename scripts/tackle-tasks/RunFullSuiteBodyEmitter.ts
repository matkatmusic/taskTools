// Sole home of the run-full-suite prompt, the "run the full suite" box in plans/diagram/pipeline-suite.mmd.
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";

// The receipt that box hands back.
export type RunFullSuiteReceipt = {
    passed: boolean;
};

const RUN_FULL_SUITE_SCRIPT = fileURLToPath(new URL("./runFullSuite.ts", import.meta.url));

// The diagram box label, so a reconciled step result names the box it came from.
const STEP_ID = "run the full suite";

// A generated artifact, matching plans/full-suite-*.json in .gitignore so `git add` never picks it up.
const resultFile = (t: PreparedTask, root: string) => `${root}/plans/full-suite-${t.number}.json`;

export function runFullSuitePrompt(t: PreparedTask, runId: string, sourceBranch: string): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    // Serialized, never interpolated, and delivered on quoted-heredoc stdin.
    const payload = JSON.stringify({
        taskNumber: t.number,
        expectedRunId: runId,
        worktreePath: root,
        sourceBranch,
        stepId: STEP_ID,
        projectRoot: t.taskStateRoot,
    });
    return `## YOUR JOB

Run the whole test suite for \`${root}\` and report the verdict.
You edit nothing, and you judge nothing.

## THE COMMAND

Run the following multi-line command using Bash(), verbatim, as one single call.
It takes a few minutes; wait for it rather than abandoning it.

\`\`\`\`sh
SUITE_FILE=${resultFile(t, root)}
node ${RUN_FULL_SUITE_SCRIPT} <<'TTPAYLOAD' >"$SUITE_FILE"
${payload}
TTPAYLOAD
node ${RUN_FULL_SUITE_SCRIPT} verdict "$SUITE_FILE"
\`\`\`\`

## WHAT TO RETURN

Return the second command's output verbatim.

If the first command leaves \`$SUITE_FILE\` empty, or the second prints nothing, say so plainly and return nothing else.
That is an operational failure, and a later box owns it.`;
}
