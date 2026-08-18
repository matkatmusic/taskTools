// Sole home of the test-review prompt, the "codex reviews the tests" box in plans/diagram/pipeline-reviewTests.mmd.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";

// The receipt that box hands back.
export type TestReviewReceipt = {
    flagged: boolean;
    notes: string;
};

const REVIEW_TESTS_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-tests-template.json", import.meta.url));
const REVIEW_TESTS_SCHEMA_PATH = fileURLToPath(new URL("../../plans/review-tests-schema.json", import.meta.url));
const REVIEW_TESTS_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-tests-error-template.json", import.meta.url));
const REVIEW_TESTS_OUTPUT_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-tests-output-template.json", import.meta.url));

// Every reviewer opens these itself, so one question serves codex and the claude fallbacks alike.
const reviewedPaths = (t: PreparedTask) => [t.briefFile, t.planFile, ...t.testFilePaths, REVIEW_TESTS_TEMPLATE_PATH];

function reviewTestsQuestion(t: PreparedTask): string {
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

${reviewedPaths(t).map((path) => `- ${path}`).join("\n")}

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

export function reviewTestsPrompt(t: PreparedTask): string {
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
${reviewTestsQuestion(t)}
REVIEWEOF
)
REVIEW_FILE=${t.testReviewFile}
codex exec -s read-only --output-schema ${REVIEW_TESTS_SCHEMA_PATH} -o "$REVIEW_FILE" "$REVIEW_PROMPT" </dev/null >/dev/null \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort medium </dev/null >"$REVIEW_FILE" \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort high </dev/null >"$REVIEW_FILE"
cat "$REVIEW_FILE"
\`\`\`\`

The \`||\` chain is the fallback. 
A non-zero exit means that reviewer was unavailable, not that the tests are bad, so the next one runs.

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Use the exact JSON shape given by \`${REVIEW_TESTS_OUTPUT_TEMPLATE_PATH}\`, which the read-file skill put into your context. 
Replace every <...> with a real value. 
Copy what the command printed; never decide for yourself whether a test is good.`;
}
