// CODEX_REVIEWS_TESTS, from pipeline-reviewTests.mmd. Ported from scripts/tackle-tasks/CodexTestReviewBodyEmitter.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromptOutputTemplate } from "../../contracts.ts";
import { loadPreparedTask } from "../../tackle-tasks/preparedTask.ts";
import { getCurrentTaskRun } from "../../tackle-tasks/taskRunState.ts";
import { reviewTestsQuestion } from "../../tackle-tasks/CodexTestReviewBodyEmitter.ts";
import type { ReviewTestsCorePacket } from "./GREEN_IMPLEMENTATION_INPUT.ts";

// const REVIEW_TESTS_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-tests-template.json", import.meta.url));
const REVIEW_TESTS_SCHEMA_PATH = fileURLToPath(new URL("../../../plans/review-tests-schema.json", import.meta.url));
// const REVIEW_TESTS_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-tests-error-template.json", import.meta.url));
const DECIDE_REVIEW_SCRIPT = fileURLToPath(new URL("../../tackle-tasks/decideTestReview.ts", import.meta.url));

// The reviewer is read-only and cannot run git, so the diff it judges against is written out for it.
function writeImplementationDiff(worktree: string, taskNumber: number, sourceBranch: string): { diffPath: string; mergeBase: string } {
    const git = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    const mergeBase = git("merge-base", sourceBranch, "HEAD").trim();
    const diffPath = `${worktree}/plans/implementation-diff-${taskNumber}.patch`;
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, git("diff", `${mergeBase}..HEAD`));
    return { diffPath, mergeBase };
}

// A test file that already existed at the merge-base was not written by this task.
function wasPreExisting(worktree: string, mergeBase: string, absoluteTestFilePath: string): boolean {
    const relativePath = relative(worktree, absoluteTestFilePath);
    try {
        execFileSync("git", ["-C", worktree, "cat-file", "-e", `${mergeBase}:${relativePath}`], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/* Retired: reviewTestsQuestion moved to CodexTestReviewBodyEmitter.ts, the single source of the review text.

function reviewTestsQuestion(
    briefFile: string, planFile: string, testFilePaths: string[], diffPath: string,
    preExistingTestFiles: string[], testCommand: string, testOutput: string,
): string {
    const reviewedPaths = [briefFile, planFile, ...testFilePaths, diffPath, REVIEW_TESTS_TEMPLATE_PATH];
    return `You are a read-only review agent tasked with reviewing the tests written for this task.
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

${reviewedPaths.map((path) => `- ${path}`).join("\n")}

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

Judge each test against what \`${briefFile}\` and \`${planFile}\` asked for.

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
The command that runs you captures that message to the review file, so do not try to write the file yourself.
`;
}
*/

// Derived here, never accepted from the caller: the run that judged the task tests recorded all of this.
function taskTestRunOutput(taskNumber: number, projectRoot: string): string {
    const taskTests = getCurrentTaskRun(taskNumber, projectRoot)?.taskTests;
    if (!taskTests) throw new Error(`review-tests: task ${taskNumber} has no recorded task-test run; this box runs only after "run task tests"`);
    return taskTests.output;
}

function reviewTestsPrompt(packet: ReviewTestsCorePacket): string {
    const worktree = packet.worktreePath.replace(/\/+$/, "");
    const t = loadPreparedTask(packet.taskNumber, worktree, packet.projectRoot);
    const testCommand = t.tests ?? "(no test command recorded)";
    const testOutput = taskTestRunOutput(packet.taskNumber, packet.projectRoot);
    const testReviewFile = t.testReviewFile;
    const { diffPath, mergeBase } = writeImplementationDiff(worktree, packet.taskNumber, packet.sourceBranch);
    const preExistingTestFiles = t.testFilePaths.filter((path) => wasPreExisting(worktree, mergeBase, path));
    const question = reviewTestsQuestion(t, diffPath, preExistingTestFiles, testCommand, testOutput);
    const promptFile = `${worktree}/plans/CODEX_REVIEWS_TESTS.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, question);

    return `You are spawning a review agent running in the CLI.
You do not edit any files; your job is to run the following command and report back exactly what it printed.
The command runs a reviewing agent against this task's test files, then rules on its verdict.

## THE COMMAND

Run the following multi-line command using Bash(), verbatim, as one single call.
It takes a few minutes; wait for it rather than abandoning it.
\`</dev/null\` matters — codex hangs forever waiting on stdin without it. \`-o\` keeps codex from mixing its banner into the answer, and \`--output-schema\` makes it bare JSON.

\`\`\`\`sh
REVIEW_PROMPT=$(cat "${promptFile}")
REVIEW_FILE=${testReviewFile}
codex exec -s read-only --output-schema ${REVIEW_TESTS_SCHEMA_PATH} -o "$REVIEW_FILE" "$REVIEW_PROMPT" </dev/null >/dev/null \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort medium </dev/null >"$REVIEW_FILE" \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort high </dev/null >"$REVIEW_FILE"
node ${DECIDE_REVIEW_SCRIPT} <"$REVIEW_FILE"
\`\`\`\`

The \`||\` chain is the fallback.
A non-zero exit means that reviewer was unavailable, not that the tests are bad, so the next one runs.

The last line prints \`{"flagged": <boolean>, "notes": "<string>"}\`.
Never decide that verdict yourself; copy it from what the command printed.
`;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as ReviewTestsCorePacket;
    const prompt = reviewTestsPrompt(packet);
    return { ...buildPromptOutputTemplate("CODEX_REVIEWS_TESTS"), prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
