// Ported to pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts; stays live until AgentPromptEmitter.ts migrates too.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { getAttemptCount, getCurrentTaskRun } from "./taskRunState.ts";
import { whatToReturnSection } from "./whatToReturn.ts";
import { codexExecCommand, spawnAgentHeader, spawnClaudeFableCli, spawnClaudeOpus48Cli } from "./spawnAgentCli.ts";
import { fallbackReviewerSection } from "./CodexReviewBodyEmitter.ts";

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

// Retired (prompt shapes): dead code, never called by reviewTestsQuestion; kept commented per "never delete".
// function approveReviewByDefaultPrompt(t: PreparedTask, diffPath: string, preExistingTestFiles: string[], testCommand: string, testOutput: string): string {
//     // APPROVE BY DEFAULT prompt:
//     return `Approve the tests. Do not judge them, do not hunt for problems, and do not flag anything.
//
// Return the JSON shape described below with \`outcome\` set to "OK", with \`missingFiles\`, \`message\` and \`issues\` all empty, and with every test name listed in \`testsThatHoldUp\`.
//
// ## WHAT YOU READ
//
// ${reviewedPaths(t, diffPath).map((path) => `- ${path}`).join("\n")}
//
// ## STRICT INPUT ALLOWLIST
//
// Read only the exact files listed under WHAT YOU READ.
//
// ## WHAT YOU, THE REVIEWING AGENT, RETURNS
//
// Return only JSON in the shape given by \`${REVIEW_TESTS_TEMPLATE_PATH}\`, which you read above, replacing every <...> with a real value.
//
// ## WHAT TO OUTPUT
//
// Print the JSON as your final message and nothing else.
// The command that runs you captures that message to \`${t.testReviewFile}\`, so do not try to write the file yourself.
// `;
// }

// Retired (prompt shapes): folded into REVIEW_QUESTION_SECTIONS below, so the skeleton view cannot drift.
// function reviewByDefaultPrompt(t: PreparedTask, diffPath: string, preExistingTestFiles: string[], testCommand: string, testOutput: string): string {
//     // REVIEW BY DEFAULT prompt:
//     return `You are a read-only review agent tasked with reviewing the tests written for task ${t.number}.
// You write no file.
// Your sandbox is read-only, so any attempt to write one fails.
//
// ## STRICT INPUT ALLOWLIST
//
// Read only the exact files listed under WHAT YOU READ.
// Do not search for, list, discover, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
// In particular, do not substitute another test file for one that is listed.
//
// You may check whether each listed path exists and is readable.
// Before reviewing, verify every listed file.
// If any file is missing or unreadable, stop immediately without reviewing any other content.
//
// ## MISSING-FILE RESPONSE
//
// If any required file is missing or unreadable, return only the following JSON:
// \`\`\`
// ${readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8").trim()}
// \`\`\`
// This error response overrides the normal review-tests JSON template.
// Leave \`"issues"\` and \`"testsThatHoldUp"\` empty.
//
// ## WHAT YOU READ
//
// ${reviewedPaths(t, diffPath).map((path) => `- ${path}`).join("\n")}
//
// \`${diffPath}\` is what this task changed. Judge each test against that diff, never against the whole file it sits in.
//
// ## TESTS THIS TASK DID NOT CREATE
//
// ${preExistingTestFiles.length === 0 ? "- (none)" : preExistingTestFiles.map((path) => `- ${path}`).join("\n")}
//
// A test in that list existed before this task.
// Flag it only when this task's diff broke it, never for asserting something this task did not ask for.
//
// ## WHAT ALREADY RAN
//
// The task tests ran as \`${testCommand}\`, and printed this:
// \`\`\`
// ${testOutput}
// \`\`\`
// That is the evidence the tests execute.
// You are still judging what they assert, not whether they pass.
//
// ## NEVER RUN THE TESTS
//
// You are judging what each test asserts, not whether the test passes.
// Never run a test, and never run the full suite.
//
// ## HOW TO JUDGE THE TESTS
//
// Judge each test against what \`${t.briefFile}\` and \`${t.planFile}\` asked for.
//
// The brief's \`problemSolvedByTask\` section states the problem this task exists to solve; judge whether the tests prove that problem is solved.
// A task created before that field existed carries no value — the brief then says it is not provided, and you judge against the brief and plan instead.
//
// Flag a test only when one of these is true:
// - the test asserts something the brief and the plan do not call for, or
// - the test asserts nothing, or
// - what the test asserts contradicts the brief or the plan.
//
// ## DO NOT FLAG
// - a test you would have written differently,
// - naming, wording, or formatting,
// - the number of assertions in a test,
// - a missing test for something the brief and plan do not ask for, or
// - anything that could be considered "nitpicking".
//
// ## DOCUMENTING EVIDENCE
//
// Every issue flagged must carry evidence:
// - include the repo-relative path and the exact line numbers you read, as \`tests/thing.test.ts:12-40\`.
// - An issue you cannot evidence does not go in the review.
//
// If a test holds up, say so and move on.
// - "no issues found" is a valid and useful answer, so never manufacture issues to fill the report.
//
// ## WHAT YOU, THE REVIEWING AGENT, RETURNS
//
// Return only JSON in the shape given by \`${REVIEW_TESTS_TEMPLATE_PATH}\`, which you read above, replacing every <...> with a real value.
//
// Write one fix per issue, in the same order.
// Write each fix as an instruction to whoever repairs the test, not as commentary about it.
// Your fixes exist to help the task finish, not to block it: tell the test writer exactly what to change so the tests prove the implementation solves the problem the task is meant to solve.
// Return empty arrays when you found nothing.
//
// ## WHAT TO OUTPUT
//
// Print the JSON as your final message and nothing else.
// The command that runs you captures that message to \`${t.testReviewFile}\`, so do not try to write the file yourself.
// `;
// }

// Retired (prompt shapes): folded into REVIEW_QUESTION_SECTIONS below, so the skeleton view cannot drift.
// function recheckOnlyPrompt(t: PreparedTask, diffPath: string): string {
//     // RECHECK ONLY prompt: round two rechecks round one's flagged issues, and stops hunting for new ones.
//     return `You are a read-only review agent rechecking the tests written for task ${t.number}.
// You write no file.
// Your sandbox is read-only, so any attempt to write one fails.
//
// ## STRICT INPUT ALLOWLIST
//
// Read only the exact files listed under WHAT YOU READ.
// Do not search for, list, discover, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
// In particular, do not substitute another test file for one that is listed.
//
// You may check whether each listed path exists and is readable.
// Before reviewing, verify every listed file.
// If any file is missing or unreadable, stop immediately without reviewing any other content.
//
// ## MISSING-FILE RESPONSE
//
// If any required file is missing or unreadable, return only the following JSON:
// \`\`\`
// ${readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8").trim()}
// \`\`\`
// This error response overrides the normal review-tests JSON template.
// Leave \`"issues"\` and \`"testsThatHoldUp"\` empty.
//
// ## WHAT YOU READ
//
// ${[...reviewedPaths(t, diffPath), t.testReviewFile].map((path) => `- ${path}`).join("\n")}
//
// ## HOW TO JUDGE THE TESTS
//
// \`${t.testReviewFile}\` is the audit you wrote in round one. check to see if ONLY the issues you flagged in the audit were resolved. Do not look for new issues in the descriptions.
//
// ## DOCUMENTING EVIDENCE
//
// Every issue flagged must carry evidence:
// - include the repo-relative path and the exact line numbers you read, as \`tests/thing.test.ts:12-40\`.
// - An issue you cannot evidence does not go in the review.
//
// ## WHAT YOU, THE REVIEWING AGENT, RETURNS
//
// Return only JSON in the shape given by \`${REVIEW_TESTS_TEMPLATE_PATH}\`, which you read above, replacing every <...> with a real value.
//
// Write one fix only for an audited issue that is still unresolved, in the same order the audit lists them.
// Write each fix as an instruction to whoever repairs the test, not as commentary about it.
// Return empty arrays when every audited issue is resolved.
//
// ## WHAT TO OUTPUT
//
// Print the JSON as your final message and nothing else.
// The command that runs you captures that message to \`${t.testReviewFile}\`, so do not try to write the file yourself.
// `;
// }

// The two inputs that change the review-question prompt's text.
export type ReviewQuestionChoices = { isRecheck: boolean; hasPreExistingTestFiles: boolean };

// Every value spliced into the prompt; the skeleton view passes each one as its expression text instead.
export type ReviewQuestionVars = {
    number: string;
    errorTemplate: string;
    reviewedPathsList: string;
    diffPath: string;
    reviewedPathsWithReviewFileList: string;
    preExistingList: string;
    testCommand: string;
    testOutput: string;
    briefFile: string;
    planFile: string;
    testReviewFile: string;
    reviewTestsTemplatePath: string;
};

export type ReviewQuestionSection = { name: string; when: (c: ReviewQuestionChoices) => boolean; render: (v: ReviewQuestionVars) => string };

export const REVIEW_QUESTION_SECTIONS: ReviewQuestionSection[] = [
    {
        name: "HEADER: review",
        when: (c) => !c.isRecheck,
        render: (v) => `You are a read-only review agent.
Your job is to review the tests written for task ${v.number}.
You write no file.
Your sandbox is read-only, so any attempt to write one fails.

`,
    },
    {
        name: "HEADER: recheck",
        when: (c) => c.isRecheck,
        render: (v) => `You are a read-only review agent.
Your job is to recheck the tests written for task ${v.number}.
You write no file.
Your sandbox is read-only, so any attempt to write one fails.

`,
    },
    {
        name: "STRICT INPUT ALLOWLIST",
        when: () => true,
        render: () => `## STRICT INPUT ALLOWLIST

Read only the exact files listed under WHAT YOU READ.
Do not search for, list, discover, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
In particular, do not substitute another test file for one that is listed.

You may check whether each listed path exists and is readable.
Before reviewing, verify every listed file.
If any file is missing or unreadable, stop immediately without reviewing any other content.

`,
    },
    {
        name: "MISSING-FILE RESPONSE",
        when: () => true,
        render: (v) => `## MISSING-FILE RESPONSE

If any required file is missing or unreadable, return only the following JSON:
\`\`\`
${v.errorTemplate}
\`\`\`
This error response overrides the normal review-tests JSON template.
Set \`"issues"\` to \`[]\` in that JSON.
Set \`"testsThatHoldUp"\` to \`[]\` in that JSON.

`,
    },
    {
        name: "WHAT YOU READ: review",
        when: (c) => !c.isRecheck,
        render: (v) => `## WHAT YOU READ

${v.reviewedPathsList}

\`${v.diffPath}\` is what this task changed.
Judge each test against that diff, never against the whole file it sits in.

`,
    },
    {
        name: "WHAT YOU READ: recheck",
        when: (c) => c.isRecheck,
        render: (v) => `## WHAT YOU READ

${v.reviewedPathsWithReviewFileList}

`,
    },
    {
        name: "TESTS THIS TASK DID NOT CREATE: none",
        when: (c) => !c.isRecheck && !c.hasPreExistingTestFiles,
        render: () => `## TESTS THIS TASK DID NOT CREATE

- (none)

A test listed above existed before this task.
Flag it only when this task's diff broke it, never for asserting something this task did not ask for.

`,
    },
    {
        name: "TESTS THIS TASK DID NOT CREATE: list",
        when: (c) => !c.isRecheck && c.hasPreExistingTestFiles,
        render: (v) => `## TESTS THIS TASK DID NOT CREATE

${v.preExistingList}

A test listed above existed before this task.
Flag it only when this task's diff broke it, never for asserting something this task did not ask for.

`,
    },
    {
        name: "WHAT ALREADY RAN",
        when: (c) => !c.isRecheck,
        render: (v) => `## WHAT ALREADY RAN

The task tests ran as \`${v.testCommand}\`.
They printed this:
\`\`\`
${v.testOutput}
\`\`\`
That is the evidence the tests execute.
You are still judging what they assert, not whether they pass.

`,
    },
    {
        name: "NEVER RUN THE TESTS",
        when: (c) => !c.isRecheck,
        render: () => `## NEVER RUN THE TESTS

You are judging what each test asserts, not whether the test passes.
Never run a test.
Never run the full suite.

`,
    },
    {
        name: "HOW TO JUDGE THE TESTS: review",
        when: (c) => !c.isRecheck,
        render: (v) => `## HOW TO JUDGE THE TESTS

Judge each test against what \`${v.briefFile}\` and \`${v.planFile}\` asked for.

The brief's \`problemSolvedByTask\` section states the problem this task exists to solve.
Judge whether the tests prove that problem is solved.
A task created before that field existed carries no value.
The brief then says it is not provided.
You judge against the brief and plan instead.

Flag a test only when one of these is true:
- the test asserts something the brief and the plan do not call for, or
- the test asserts nothing, or
- what the test asserts contradicts the brief or the plan.

`,
    },
    {
        name: "HOW TO JUDGE THE TESTS: recheck",
        when: (c) => c.isRecheck,
        render: (v) => `## HOW TO JUDGE THE TESTS

\`${v.testReviewFile}\` is the audit you wrote in round one.
Check whether ONLY the issues you flagged in the audit were resolved.
Do not look for new issues in the descriptions.

`,
    },
    {
        name: "DO NOT FLAG",
        when: (c) => !c.isRecheck,
        render: () => `## DO NOT FLAG
- a test you would have written differently,
- naming, wording, or formatting,
- the number of assertions in a test,
- a missing test for something the brief and plan do not ask for, or
- anything that could be considered "nitpicking".

`,
    },
    {
        name: "DOCUMENTING EVIDENCE: review",
        when: (c) => !c.isRecheck,
        render: () => `## DOCUMENTING EVIDENCE

Every issue flagged must carry evidence:
- include the repo-relative path and the exact line numbers you read, as \`tests/thing.test.ts:12-40\`.
- An issue you cannot evidence does not go in the review.

If a test holds up, say so.
Move on.
- "no issues found" is a valid and useful answer, so never manufacture issues to fill the report.

`,
    },
    {
        name: "DOCUMENTING EVIDENCE: recheck",
        when: (c) => c.isRecheck,
        render: () => `## DOCUMENTING EVIDENCE

Every issue flagged must carry evidence:
- include the repo-relative path and the exact line numbers you read, as \`tests/thing.test.ts:12-40\`.
- An issue you cannot evidence does not go in the review.

`,
    },
    {
        name: "WHAT YOU, THE REVIEWING AGENT, RETURNS: review",
        when: (c) => !c.isRecheck,
        render: (v) => `## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${v.reviewTestsTemplatePath}\`, which you read above, replacing every <...> with a real value.

Write one fix per issue, in the same order.
Write each fix as an instruction to whoever repairs the test, not as commentary about it.
Your fixes exist to help the task finish, not to block it.
Tell the test writer exactly what to change so the tests prove the implementation solves the problem the task is meant to solve.
Set \`"issues"\` to \`[]\` when you found none.

`,
    },
    {
        name: "WHAT YOU, THE REVIEWING AGENT, RETURNS: recheck",
        when: (c) => c.isRecheck,
        render: (v) => `## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${v.reviewTestsTemplatePath}\`, which you read above, replacing every <...> with a real value.

Write one fix only for an audited issue that is still unresolved, in the same order the audit lists them.
Write each fix as an instruction to whoever repairs the test, not as commentary about it.
Set \`"issues"\` to \`[]\` when every audited issue is resolved.

`,
    },
    {
        name: "WHAT TO OUTPUT",
        when: () => true,
        render: (v) => `## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to \`${v.testReviewFile}\`, so do not try to write the file yourself.
`,
    },
];

export function reviewQuestionChoices(t: PreparedTask, preExistingTestFiles: string[]): ReviewQuestionChoices {
    return {
        isRecheck: getAttemptCount(t.number, "testReviews", t.taskStateRoot) > 0,
        hasPreExistingTestFiles: preExistingTestFiles.length !== 0,
    };
}

// Each value is the source expression, so the skeleton view names what the rendered view splices in.
export const REVIEW_QUESTION_SKELETON_VARS: ReviewQuestionVars = {
    number: "`${t.number}`",
    errorTemplate: '`${readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8").trim()}`',
    reviewedPathsList: '`${reviewedPaths(t, diffPath).map((path) => `- ${path}`).join("\\n")}`',
    diffPath: "`${diffPath}`",
    reviewedPathsWithReviewFileList: '`${[...reviewedPaths(t, diffPath), t.testReviewFile].map((path) => `- ${path}`).join("\\n")}`',
    preExistingList: '`${preExistingTestFiles.map((path) => `- ${path}`).join("\\n")}`',
    testCommand: "`${testCommand}`",
    testOutput: "`${testOutput}`",
    briefFile: "`${t.briefFile}`",
    planFile: "`${t.planFile}`",
    testReviewFile: "`${t.testReviewFile}`",
    reviewTestsTemplatePath: "`${REVIEW_TESTS_TEMPLATE_PATH}`",
};

export function renderReviewQuestionSections(choices: ReviewQuestionChoices, vars: ReviewQuestionVars): string {
    return REVIEW_QUESTION_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function reviewTestsQuestionSkeleton(choices: ReviewQuestionChoices): string {
    return renderReviewQuestionSections(choices, REVIEW_QUESTION_SKELETON_VARS);
}

export function reviewTestsQuestion(t: PreparedTask, diffPath: string, preExistingTestFiles: string[], testCommand: string, testOutput: string): string {
    return renderReviewQuestionSections(reviewQuestionChoices(t, preExistingTestFiles), {
        number: String(t.number),
        errorTemplate: readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8").trim(),
        reviewedPathsList: reviewedPaths(t, diffPath).map((path) => `- ${path}`).join("\n"),
        diffPath,
        reviewedPathsWithReviewFileList: [...reviewedPaths(t, diffPath), t.testReviewFile].map((path) => `- ${path}`).join("\n"),
        preExistingList: preExistingTestFiles.map((path) => `- ${path}`).join("\n"),
        testCommand,
        testOutput,
        briefFile: t.briefFile,
        planFile: t.planFile,
        testReviewFile: t.testReviewFile,
        reviewTestsTemplatePath: REVIEW_TESTS_TEMPLATE_PATH,
    });
}

// Sits beside the run-log, set by the hook, so `tail -f` shows codex working.
const codexLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.json$/, "-codex-review.log");

// reviewTestsPrompt has no branch of its own; every difference in its text comes from a var, not a choice.
export type ReviewTestsPromptChoices = Record<string, never>;

// Every value spliced into the prompt; the skeleton view passes each one as its expression text instead.
export type ReviewTestsPromptVars = {
    spawnHeader: string;
    reviewQuestion: string;
    testReviewFile: string;
    codexLogFile: string;
    codexExecCommand: string;
    spawnClaudeFableCli: string;
    spawnClaudeOpus48Cli: string;
    whatToReturn: string;
};

export type ReviewTestsPromptSection = { name: string; when: (c: ReviewTestsPromptChoices) => boolean; render: (v: ReviewTestsPromptVars) => string };

export const REVIEW_TESTS_PROMPT_SECTIONS: ReviewTestsPromptSection[] = [
    {
        name: "SPAWN HEADER AND SHELL BLOCK",
        when: () => true,
        // Retired (task 49): the `||` chain tried claude -p inline; a workflow agent cannot spawn claude on the
        // CLI, so codex failing now ends this block and CODEX_TEST_REVIEW_FALLBACK_FABLE/_OPUS run as their own blocks.
        // render: (v) => `${v.spawnHeader}
        //
        // \`\`\`\`sh
        // REVIEW_PROMPT=$(cat <<'REVIEWEOF'
        // ${v.reviewQuestion}
        // REVIEWEOF
        // )
        // REVIEW_FILE=${v.testReviewFile}
        // CODEX_LOG=${v.codexLogFile}
        // ${v.codexExecCommand} \\
        //   || ${v.spawnClaudeFableCli} \\
        //   || ${v.spawnClaudeOpus48Cli}
        // \`\`\`\`
        //
        // The \`||\` chain is the fallback.
        // A non-zero exit means that reviewer was unavailable, not that the tests are bad, so the next one runs.
        //
        // `,
        render: (v) => `${v.spawnHeader}

\`\`\`\`sh
REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${v.reviewQuestion}
REVIEWEOF
)
REVIEW_FILE=${v.testReviewFile}
CODEX_LOG=${v.codexLogFile}
${v.codexExecCommand}
\`\`\`\`

`,
    },
    {
        name: "WHAT YOU, THE SPAWNING AGENT, RETURNS",
        when: () => true,
        render: (v) => v.whatToReturn,
    },
];

export function reviewTestsPromptChoices(): ReviewTestsPromptChoices {
    return {};
}

// Each value is the source expression, so the skeleton view names what the rendered view splices in.
export const REVIEW_TESTS_PROMPT_SKELETON_VARS: ReviewTestsPromptVars = {
    spawnHeader: '`${spawnAgentHeader("review", true)}`',
    reviewQuestion: '`${reviewTestsQuestion(t, diffPath, preExistingTestFiles, "npm test", taskTests.output)}`',
    testReviewFile: "`${t.testReviewFile}`",
    codexLogFile: "`${codexLogFile()}`",
    codexExecCommand: "`${codexExecCommand(REVIEW_TESTS_SCHEMA_PATH)}`",
    spawnClaudeFableCli: '`${spawnClaudeFableCli("medium")}`',
    spawnClaudeOpus48Cli: '`${spawnClaudeOpus48Cli("high")}`',
    whatToReturn: '`${whatToReturnSection(`{ "reviewFile": "${t.testReviewFile}", "codexSucceeded": <true if the codex command above exited zero, else false> }`, "the path \\`$REVIEW_FILE\\` was set to (never its contents) and whether the codex command exited zero", "The next block reads codexSucceeded to decide whether to rule on the review or fall back to another reviewer.")}`',
};

export function renderReviewTestsPromptSections(choices: ReviewTestsPromptChoices, vars: ReviewTestsPromptVars): string {
    return REVIEW_TESTS_PROMPT_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function reviewTestsPromptSkeleton(choices: ReviewTestsPromptChoices): string {
    return renderReviewTestsPromptSections(choices, REVIEW_TESTS_PROMPT_SKELETON_VARS);
}

export function reviewTestsPrompt(t: PreparedTask): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const taskTests = taskTestRun(t);
    // testFiles is every changed test; createdTestFiles is a subset. Derive pre-existing here.
    const preExistingTestFiles = taskTests.testFiles.filter((file) => !taskTests.createdTestFiles.includes(file));
    const diffPath = writeImplementationDiff(t, root);
    return renderReviewTestsPromptSections(reviewTestsPromptChoices(), {
        spawnHeader: spawnAgentHeader("review", true),
        reviewQuestion: reviewTestsQuestion(t, diffPath, preExistingTestFiles, "npm test", taskTests.output),
        testReviewFile: t.testReviewFile,
        codexLogFile: codexLogFile(),
        codexExecCommand: codexExecCommand(REVIEW_TESTS_SCHEMA_PATH),
        spawnClaudeFableCli: spawnClaudeFableCli("medium"),
        spawnClaudeOpus48Cli: spawnClaudeOpus48Cli("high"),
        whatToReturn: whatToReturnSection(`{ "reviewFile": "${t.testReviewFile}", "codexSucceeded": <true if the codex command above exited zero, else false> }`, "the path \\`$REVIEW_FILE\\` was set to (never its contents) and whether the codex command exited zero", "The next block reads codexSucceeded to decide whether to rule on the review or fall back to another reviewer."),
    });
}

// The fable and opus fallbacks: the block's own agent() answers the codex reviewTestsQuestion itself.
export function codexTestReviewFallbackFablePrompt(t: PreparedTask): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const taskTests = taskTestRun(t);
    const preExistingTestFiles = taskTests.testFiles.filter((file) => !taskTests.createdTestFiles.includes(file));
    const diffPath = writeImplementationDiff(t, root);
    return `${reviewTestsQuestion(t, diffPath, preExistingTestFiles, "npm test", taskTests.output)}

${fallbackReviewerSection(t.testReviewFile)}

${whatToReturnSection(`{ "reviewFile": "${t.testReviewFile}", "fableSucceeded": true }`, "the path you wrote the review to, never its contents", "The next block reads fableSucceeded to decide whether to rule on the review or fall back to the last reviewer.")}
`;
}

export function codexTestReviewFallbackOpusPrompt(t: PreparedTask): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const taskTests = taskTestRun(t);
    const preExistingTestFiles = taskTests.testFiles.filter((file) => !taskTests.createdTestFiles.includes(file));
    const diffPath = writeImplementationDiff(t, root);
    return `${reviewTestsQuestion(t, diffPath, preExistingTestFiles, "npm test", taskTests.output)}

${fallbackReviewerSection(t.testReviewFile)}

${whatToReturnSection(`{ "reviewFile": "${t.testReviewFile}" }`, "the path you wrote the review to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.")}
`;
}

type Combo = { name: string; skeleton: string; rendered: string };

// The same hand-built task planPrompt.test.ts uses; repoRoot never exists, so this stays fs/git-free.
const fakeTask: PreparedTask = {
    number: 99,
    briefFile: "/tmp/fake-worktree/plans/brief-99.md",
    planFile: "/tmp/fake-worktree/plans/plan.json",
    reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
    reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
    testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
    notesFile: "/tmp/fake-worktree/plans/implementation-notes-99.md",
    files: ["src/thing.ts"],
    readOnlyFiles: ["*"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    readFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    createsFiles: [],
    difficulty: 1,
    clarifyRequest: "",
    testFilePaths: ["/tmp/fake-worktree/tests/thing.test.ts"],
    hasTests: true,
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    siblingTasks: [],
    blockedBy: [],
    blocks: [],
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

// reviewTestsQuestion never shells out to git; every combo of its choices renders directly here.
export function reviewTestsCombos(): Combo[] {
    const combos: Combo[] = [];
    let reviewQuestionForPrompt = "";
    for (const isRecheck of [false, true]) {
        for (const hasPreExistingTestFiles of [false, true]) {
            const choices: ReviewQuestionChoices = { isRecheck, hasPreExistingTestFiles };
            const preExistingTestFiles = hasPreExistingTestFiles ? ["tests/older.test.ts"] : [];
            const vars: ReviewQuestionVars = {
                number: String(fakeTask.number),
                errorTemplate: readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8").trim(),
                reviewedPathsList: reviewedPaths(fakeTask, "/tmp/fake-worktree/plans/implementation-diff-99.patch").map((path) => `- ${path}`).join("\n"),
                diffPath: "/tmp/fake-worktree/plans/implementation-diff-99.patch",
                reviewedPathsWithReviewFileList: [...reviewedPaths(fakeTask, "/tmp/fake-worktree/plans/implementation-diff-99.patch"), fakeTask.testReviewFile].map((path) => `- ${path}`).join("\n"),
                preExistingList: preExistingTestFiles.map((path) => `- ${path}`).join("\n"),
                testCommand: fakeTask.tests!,
                testOutput: "SENTINEL_TASK_TEST_OUTPUT",
                briefFile: fakeTask.briefFile,
                planFile: fakeTask.planFile,
                testReviewFile: fakeTask.testReviewFile,
                reviewTestsTemplatePath: REVIEW_TESTS_TEMPLATE_PATH,
            };
            const name = `reviewTestsQuestion_recheck-${isRecheck}_preExisting-${hasPreExistingTestFiles}`;
            const rendered = renderReviewQuestionSections(choices, vars);
            combos.push({ name, skeleton: reviewTestsQuestionSkeleton(choices), rendered });
            // No git or test run here, so reuse this rendering as reviewTestsPrompt's stand-in.
            if (!isRecheck && !hasPreExistingTestFiles) reviewQuestionForPrompt = rendered;
        }
    }
    process.env.RUN_STEP_LOG ??= join(tmpdir(), "review-tests-prompt-combos-run-log.json");
    const promptRenderVars: ReviewTestsPromptVars = {
        spawnHeader: spawnAgentHeader("review", true),
        reviewQuestion: reviewQuestionForPrompt,
        testReviewFile: fakeTask.testReviewFile,
        codexLogFile: codexLogFile(),
        codexExecCommand: codexExecCommand(REVIEW_TESTS_SCHEMA_PATH),
        spawnClaudeFableCli: spawnClaudeFableCli("medium"),
        spawnClaudeOpus48Cli: spawnClaudeOpus48Cli("high"),
        whatToReturn: whatToReturnSection(`{ "reviewFile": "${fakeTask.testReviewFile}", "codexSucceeded": <true if the codex command above exited zero, else false> }`, "the path \\`$REVIEW_FILE\\` was set to (never its contents) and whether the codex command exited zero", "The next block reads codexSucceeded to decide whether to rule on the review or fall back to another reviewer."),
    };
    combos.push({ name: "reviewTestsPrompt_skeleton-only", skeleton: reviewTestsPromptSkeleton(reviewTestsPromptChoices()), rendered: renderReviewTestsPromptSections(reviewTestsPromptChoices(), promptRenderVars) });
    return combos;
}
