// Ported to pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts; stays live until AgentPromptEmitter.ts migrates too.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";
import { whatToReturnSection } from "./whatToReturn.ts";
import { codexExecCommand, spawnAgentHeader, spawnClaudeFableCli, spawnClaudeOpus48Cli } from "./spawnAgentCli.ts";

const REVIEW_TESTS_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-tests-template.json", import.meta.url));
const REVIEW_TESTS_SCHEMA_PATH = fileURLToPath(new URL("../../../plans/review-tests-schema.json", import.meta.url));
const REVIEW_TESTS_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-tests-error-template.json", import.meta.url));

// A generated artifact, matching plans/implementation-diff-*.patch in .gitignore.
const diffFile = (t: PreparedTask, root: string) => `${root}/plans/implementation-diff-${t.number}.patch`;

// The reviewer is read-only and cannot run git, so the diff it judges against is written out for it.
function writeImplementationDiff(t: PreparedTask, root: string): string {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    // const baseBranch = execFileSync("git", ["-C", t.taskStateRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const baseBranch = "staging";
    const mergeBase = git("merge-base", baseBranch, "HEAD").trim();
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

function approveReviewByDefaultPrompt(t: PreparedTask, diffPath: string, preExistingTestFiles: string[], testCommand: string, testOutput: string): string {
    //APPROVE BY DEFAULT prompt:
    return `Approve the tests. Do not judge them, do not hunt for problems, and do not flag anything.

Return the JSON shape described below with \`outcome\` set to "OK", with \`missingFiles\`, \`message\` and \`issues\` all empty, and with every test name listed in \`testsThatHoldUp\`.

## WHAT YOU READ

${reviewedPaths(t, diffPath).map((path) => `- ${path}`).join("\n")}

## STRICT INPUT ALLOWLIST

Read only the exact files listed under WHAT YOU READ.

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${REVIEW_TESTS_TEMPLATE_PATH}\`, which you read above, replacing every <...> with a real value.

## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to \`${t.testReviewFile}\`, so do not try to write the file yourself.
`;
}

function reviewByDefaultPrompt(t: PreparedTask, diffPath: string, preExistingTestFiles: string[], testCommand: string, testOutput: string): string {
    //REVIEW BY DEFAULT prompt:
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

export function reviewTestsQuestion(t: PreparedTask, diffPath: string, preExistingTestFiles: string[], testCommand: string, testOutput: string): string {
    // return approveReviewByDefaultPrompt(t, diffPath, preExistingTestFiles, testCommand, testOutput);
    return reviewByDefaultPrompt(t, diffPath, preExistingTestFiles, testCommand, testOutput);    
}

// Beside the run-log, so `tail -f` on it shows codex working. The hook sets RUN_STEP_LOG for every block it spawns.
const codexLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.json$/, "-codex-review.log");

export function reviewTestsPrompt(t: PreparedTask): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const taskTests = taskTestRun(t);
    // testFiles is every changed test; createdTestFiles is a subset. Derive pre-existing here.
    const preExistingTestFiles = taskTests.testFiles.filter((file) => !taskTests.createdTestFiles.includes(file));
    const diffPath = writeImplementationDiff(t, root);
    return `${spawnAgentHeader("review", true)}

\`\`\`\`sh
REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${reviewTestsQuestion(t, diffPath, preExistingTestFiles, t.tests ?? "(no test command recorded)", taskTests.output)}
REVIEWEOF
)
REVIEW_FILE=${t.testReviewFile}
CODEX_LOG=${codexLogFile()}
${codexExecCommand(REVIEW_TESTS_SCHEMA_PATH)} \\
  || ${spawnClaudeFableCli("medium")} \\
  || ${spawnClaudeOpus48Cli("high")}
\`\`\`\`

The \`||\` chain is the fallback.
A non-zero exit means that reviewer was unavailable, not that the tests are bad, so the next one runs.

${whatToReturnSection(`{ "reviewFile": "${t.testReviewFile}" }`, "the path \\`$REVIEW_FILE\\` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.")}`;
}
