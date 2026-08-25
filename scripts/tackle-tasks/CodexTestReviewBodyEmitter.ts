// Ported to pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts; stays live until AgentPromptEmitter.ts migrates too.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";

// The receipt that box hands back.
export type TestReviewReceipt = {
    flagged: boolean;
    notes: string;
};

const REVIEW_TESTS_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-tests-template.json", import.meta.url));
const REVIEW_TESTS_SCHEMA_PATH = fileURLToPath(new URL("../../plans/review-tests-schema.json", import.meta.url));
const REVIEW_TESTS_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-tests-error-template.json", import.meta.url));
const REVIEW_TESTS_OUTPUT_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-tests-output-template.json", import.meta.url));
const DECIDE_REVIEW_SCRIPT = fileURLToPath(new URL("./decideTestReview.ts", import.meta.url));

// A generated artifact, matching plans/implementation-diff-*.patch in .gitignore.
const diffFile = (t: PreparedTask, root: string) => `${root}/plans/implementation-diff-${t.number}.patch`;

// The reviewer is read-only and cannot run git, so the diff it judges against is written out for it.
function writeImplementationDiff(t: PreparedTask, root: string, sourceBranch: string): string {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    const mergeBase = git("merge-base", sourceBranch, "HEAD").trim();
    const path = diffFile(t, root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, git("diff", `${mergeBase}..HEAD`));
    return path;
}

// Derived here, never accepted from the caller: the run that judged the task tests recorded all of this.
function taskTestRun(t: PreparedTask) {
    const taskTests = getCurrentTaskRun(t.number, t.taskStateRoot)?.taskTests;
    if (!taskTests) throw new Error(`review-tests: task ${t.number} has no recorded task-test run; this box runs only after "run task tests"`);
    return taskTests;
}

// Every reviewer opens these itself, so one question serves codex and the claude fallbacks alike.
const reviewedPaths = (t: PreparedTask, diffPath: string) => [t.briefFile, t.planFile, ...t.testFilePaths, diffPath, REVIEW_TESTS_TEMPLATE_PATH];

export function reviewTestsQuestion(t: PreparedTask, diffPath: string, preExistingTestFiles: string[], testCommand: string, testOutput: string): string {
    return `You are a read-only review agent tasked with reviewing the tests written for task ${t.number}.
You write no file.
Your sandbox is read-only, so any attempt to write one fails.

## STRICT INPUT ALLOWLIST

Read only the exact files listed under WHAT YOU READ.
Do not search for, list, discover, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
In particular, do not substitute another test file for one that is listed.

You may check whether each listed path exists and is readable.
Before reviewing, verify every listed file.
If any file is missing or unreadable, stop immediately without reviewing any other content.

## MISSING-FILE RESPONSE

If any required file is missing or unreadable, return only the following JSON:
\`\`\`
${readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8").trim()}
\`\`\`
This error response overrides the normal review-tests JSON template.
Leave \`"issues"\` and \`"testsThatHoldUp"\` empty.

## WHAT YOU READ

${reviewedPaths(t, diffPath).map((path) => `- ${path}`).join("\n")}

\`${diffPath}\` is what this task changed. Judge each test against that diff, never against the whole file it sits in.

## TESTS THIS TASK DID NOT CREATE

${preExistingTestFiles.length === 0 ? "- (none)" : preExistingTestFiles.map((path) => `- ${path}`).join("\n")}

A test in that list existed before this task.
Flag it only when this task's diff broke it, never for asserting something this task did not ask for.

## WHAT ALREADY RAN

The task tests ran as \`${testCommand}\`, and printed this:
\`\`\`
${testOutput}
\`\`\`
That is the evidence the tests execute.
You are still judging what they assert, not whether they pass.

## NEVER RUN THE TESTS

You are judging what each test asserts, not whether the test passes.
Never run a test, and never run the full suite.

## HOW TO JUDGE THE TESTS

Judge each test against what \`${t.briefFile}\` and \`${t.planFile}\` asked for.

Flag a test only when one of these is true:
- the test asserts something the brief and the plan do not call for, or
- the test asserts nothing, or
- what the test asserts contradicts the brief or the plan.

## DO NOT FLAG
- a test you would have written differently,
- naming, wording, or formatting,
- the number of assertions in a test,
- a missing test for something the brief and plan do not ask for, or
- anything that could be considered "nitpicking".

## DOCUMENTING EVIDENCE

Every issue flagged must carry evidence:
- include the repo-relative path and the exact line numbers you read, as \`tests/thing.test.ts:12-40\`.
- An issue you cannot evidence does not go in the review.

If a test holds up, say so and move on.
- "no issues found" is a valid and useful answer, so never manufacture issues to fill the report.

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${REVIEW_TESTS_TEMPLATE_PATH}\`, which you read above, replacing every <...> with a real value.

Write one fix per issue, in the same order.
Write each fix as an instruction to whoever repairs the test, not as commentary about it.
Return empty arrays when you found nothing.

## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to \`${t.testReviewFile}\`, so do not try to write the file yourself.
`;
}

export function reviewTestsPrompt(t: PreparedTask, sourceBranch: string): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const taskTests = taskTestRun(t);
    // testFiles is every changed test; createdTestFiles is a subset. Derive pre-existing here.
    const preExistingTestFiles = taskTests.testFiles.filter((file) => !taskTests.createdTestFiles.includes(file));
    const diffPath = writeImplementationDiff(t, root, sourceBranch);
    return `You are spawning a review agent running in the CLI.
You do not edit any files; Your job is to run the following command, and return exactly what was printed, in a specific JSON shape.
The command runs a reviewing agent against this task's test files.

## YOUR RETURN SHAPE

To put the required return shape into your context, Invoke the following skill verbatim:
\`\`\`
/read-file "${REVIEW_TESTS_OUTPUT_TEMPLATE_PATH}"
\`\`\`

## THE COMMAND

Run the following multi-line command using Bash(), verbatim, as one single call.
It takes a few minutes; wait for it rather than abandoning it.
\`</dev/null\` matters — codex hangs forever waiting on stdin without it. \`-o\` keeps codex from mixing its banner into the answer, and \`--output-schema\` makes it bare JSON.

\`\`\`\`sh
REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${reviewTestsQuestion(t, diffPath, preExistingTestFiles, t.tests ?? "(no test command recorded)", taskTests.output)}
REVIEWEOF
)
REVIEW_FILE=${t.testReviewFile}
codex exec -s read-only --output-schema ${REVIEW_TESTS_SCHEMA_PATH} -o "$REVIEW_FILE" "$REVIEW_PROMPT" </dev/null >/dev/null \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort medium </dev/null >"$REVIEW_FILE" \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort high </dev/null >"$REVIEW_FILE"
node ${DECIDE_REVIEW_SCRIPT} ${t.taskStateRoot} ${t.number} ARE_TESTS_FLAGGED <"$REVIEW_FILE"
\`\`\`\`

The \`||\` chain is the fallback.
A non-zero exit means that reviewer was unavailable, not that the tests are bad, so the next one runs.

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Use the exact JSON shape given by \`${REVIEW_TESTS_OUTPUT_TEMPLATE_PATH}\`, which the read-file skill put into your context.
Replace every <...> with a real value.
Copy what the node command printed; never decide a verdict yourself.`;
}
