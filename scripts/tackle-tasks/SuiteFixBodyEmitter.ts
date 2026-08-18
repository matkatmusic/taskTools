// Sole home of the suite-fix prompt, the "fix the codebase so the full suite passes" box in plans/diagram/pipeline-suite.mmd.
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { absolutePathsSection } from "./promptSections.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";

// The receipt that box hands back.
export type SuiteFixReceipt = {
    fixed: boolean;
};

const SUITE_FIX_OUTPUT_PATH = fileURLToPath(new URL("../../plans/fix-suite-output-template.json", import.meta.url));
const COMMIT_TASK_WORK_PATH = fileURLToPath(new URL("./commitTaskWork.ts", import.meta.url));

// Double-quoted for the read-file hook's parser; deduped so an owned test file is not listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

// Derived here, never accepted from the caller: runFullSuite.ts already persisted the run it judged red.
function failingSuiteOutput(t: PreparedTask): string {
    const run = getCurrentTaskRun(t.number, t.taskStateRoot);
    const fullSuite = run?.fullSuite;
    if (!fullSuite) throw new Error(`fix-suite: task ${t.number} has no recorded full-suite run; this box runs only after "run the full suite"`);
    if (fullSuite.passed) throw new Error(`fix-suite: the recorded full suite for task ${t.number} passed; this box runs only on a red suite`);
    return fullSuite.output;
}

export function suiteFixPrompt(t: PreparedTask, runId: string, sourceBranch: string): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const output = failingSuiteOutput(t);
    // Serialized, never interpolated field-by-field, and delivered on quoted-heredoc stdin.
    const commitPayload = JSON.stringify({
        projectRoot: t.taskStateRoot,
        worktreePath: t.repoRoot,
        taskNumber: t.number,
        runId,
        stepId: "fix-suite",
        rootSourceBranch: sourceBranch,
    });
    return `Invoke the skill \`/ponytail:ponytail ultra\` first.

## YOUR JOB

Fix the cause of every failure listed under FAILING SUITE OUTPUT, and change nothing else.

The full test suite in the worktree \`${root}\` is red.
You are repairing the codebase, never the suite.
A test that fails is reporting a real defect until you have proved otherwise.

## WHAT TO READ

Invoke the following skill verbatim:
\`\`\`
/read-file ${readFileArgs([...t.ownedFilePaths, ...t.testFilePaths, SUITE_FIX_OUTPUT_PATH])}
\`\`\`
This skill puts the files into your context without spending a Read tool call, so you can read them all at once.

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

${absolutePathsSection(root)}

## WHAT YOU MAY EDIT

${t.ownedFilePaths.map((path) => `- \`${path}\``).join("\n")}

This list is complete.
Every other path in the tree belongs to another task, including every test file.

If fixing the cause needs an edit outside this list, make no edit at all and return \`fixed: false\`.

## HOW TO FIX

1. Read the failing suite output below and name the single defect behind each failure.
2. Fix that defect in the paths listed above.
3. Re-run only the individual test that failed, with \`node --test <absolute test path>\`, run inside \`${root}\`.
4. Repeat until every listed failure is addressed.

## COMMIT YOUR WORK

Never stage or commit anything by hand. As your final step, run this with Bash, exactly as written:
node ${COMMIT_TASK_WORK_PATH} <<'TTCOMMIT'
${commitPayload}
TTCOMMIT

It prints one JSON object. If it fails, say so plainly and return nothing else.
That is an operational failure, and this run's operator owns it.

Never run the full suite yourself. A later box runs it and judges the result.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file at all;
- edit any path not listed under WHAT YOU MAY EDIT;
- add scope or a refactor no listed failure calls for;
- run the full suite;
- stage or commit anything by hand;
- force-push or hard-reset anything you did not create;
- return \`fixed: true\` while any listed failure is unaddressed.

Returning \`fixed: false\` is a correct outcome when the cause sits outside the paths you own.
It is not a failure, and it is always better than a guess.

## FAILING SUITE OUTPUT

\`\`\`
${output}
\`\`\`

## WHAT TO RETURN

Return the shape given by \`${SUITE_FIX_OUTPUT_PATH}\`, which the read-file skill put into your
context, replacing every \`<...>\` with a real value.`;
}
