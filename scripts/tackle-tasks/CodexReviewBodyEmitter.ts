// Sole home of the "codex reviews the plan" prompt (plans/diagram/pipeline-reviewPlan.mmd); its receipt is the review verdict, typed in planArtifacts.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPlanProblem, readAndValidatePlan, type CodexReview } from "./planArtifacts.ts";
import type { PreparedTask } from "./preparedTask.ts";

export type CodexReviewReceipt = CodexReview;

// Its own copy, so this file never imports the dispatch hub and the imports stay one-way.
const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

// ---------------------------------------------------------------------------
// review-plan — codex rules on the plan, and a script turns its answer into the verdict.
// ---------------------------------------------------------------------------

const REVIEW_PLAN_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-plan-template.json", import.meta.url));
const REVIEW_PLAN_SCHEMA_PATH = fileURLToPath(new URL("../../plans/review-plan-schema.json", import.meta.url));
const REVIEW_PLAN_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-plan-error-template.json", import.meta.url));
const REVIEW_PLAN_OUTPUT_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/review-plan-output-template.json", import.meta.url));
const RECORD_REVIEW_SCRIPT = fileURLToPath(new URL("./recordPlanReview.ts", import.meta.url));

// Serves codex and claude fallbacks alike; drops a createsFiles path since it doesn't exist yet.
const reviewedPaths = (t: PreparedTask) => {
    const plan = readAndValidatePlan(t.planFile, t.number);
    const root = t.repoRoot.replace(/\/+$/, "");
    const createdPaths = new Set(isPlanProblem(plan) ? [] : plan.createsFiles.map((file) => `${root}/${file}`));
    const owned = t.ownedFilePaths.filter((path) => !createdPaths.has(path));
    return [t.briefFile, t.planFile, ...owned, REVIEW_PLAN_TEMPLATE_PATH];
};

function reviewQuestion(t: PreparedTask): string {
    return `You are a read-only review agent tasked with reviewing the implementation plan for task ${t.number}. 
You write no file. 
Your sandbox is read-only, so any attempt to write one fails.

## STRICT INPUT ALLOWLIST

Read only the exact files listed under WHAT YOU READ. 
Do not search for, list discover, infer, or open alternative files, even if an alternative has a similar name or appears to contain the requested material. 
In particular, do not substitute another plan file for plan.json.

You may check whether each listed path exists and is readable. 
Before reviewing, verify every listed file.
If any file is missing or unreadable, stop immediately without reviewing any other content.

## MISSING-FILE RESPONSE

If any required file is missing or unreadable, return only the following JSON:
\`\`\`
${readFileSync(REVIEW_PLAN_ERROR_TEMPLATE_PATH, "utf8").trim()}
\`\`\`
This error response overrides the normal review-plan JSON template. 
Leave \`"issues"\`, \`"fixes"\` and \`"sectionsThatHoldUp"\` empty.

## WHAT YOU READ

${reviewedPaths(t).map((path) => `- ${path}`).join("\n")}

## HOW TO JUDGE THE PLAN

Check the plan for gotchas, failures, bugs, incorrect assumptions, errors, false statements, or anything that could cause the implementer to fail, waste time, or misunderstand the task.
Verify every claim against the source file it is about, never against what the plan says about it. 

The plan is good enough when an implementer could follow the plan without deciding anything the plan should have already decided: 
- every edit names its file and line numbers with the old and new text, 
- every owned file is either edited or explained as needing no edit, 
- no step is conditional, 
- nothing outside the owned files is touched, and 
- the verification is an exact command with its expected result.

## DO NOT FLAG 
- file-size or line-count claims, 
- spelling, 
- grammar, 
- style (coding or prose), 
- trivial formatting, or 
- a change that does not alter the intent of the plan. 
- anything that could be considered "nitpicking".

Flag a small issue **only** when the issue alters the intent of the plan, or when it is a factual error that could mislead an implementer.

## DOCUMENTING EVIDENCE

Every issue flagged must carry evidence: 
- include the repo-relative path and the exact line numbers you read, as \`path/to/file.ts:12-40\`, when proving an issue exists.
- A command you ran and its output counts as evidence. 
- An issue you cannot evidence does not go in the review. 

If a section holds up, say so and move on.
- "no issues found" is a valid and useful answer, so never manufacture issues to fill the report.

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${REVIEW_PLAN_TEMPLATE_PATH}\`, which you read above,
replacing every <...> with a real value.

Write one fix per issue, in the same order. 
Every \`sectionId\` must be an \`id\` the plan actually uses. 
Write each fix as an instruction to whoever repairs the plan, not as commentary about it.
Return empty arrays when you found nothing.

## WHAT TO OUTPUT 

Print the JSON as your final message and nothing else. The command that runs you captures that
message to \`${t.reviewOutputFile}\`, so do not try to write the file yourself.
`;
}

export function planReviewPrompt(t: PreparedTask): string {
    return `You are spawning a review agent running in the CLI. 
You do not edit any files; Your job is to run the following command, and return exactly what was printed, in a specific JSON shape. 
The command runs a reviewing agent against a plan file. 
    
## YOUR RETURN SHAPE

To put the required return shape into your context, Invoke the following skill verbatim: 
\`\`\`
/read-file "${REVIEW_PLAN_OUTPUT_TEMPLATE_PATH}"
\`\`\`

## THE COMMAND

Run the following multi-line command using Bash(), verbatim, as one single call. It takes a few
minutes; wait for it rather than abandoning it. \`</dev/null\` matters — codex hangs forever
waiting on stdin without it. \`-o\` keeps codex from mixing its banner into the answer, and \`--output-schema\` makes it bare JSON.

\`\`\`\`sh
REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${reviewQuestion(t)}
REVIEWEOF
)
REVIEW_FILE=${t.reviewOutputFile}
codex exec -s read-only --output-schema ${REVIEW_PLAN_SCHEMA_PATH} -o "$REVIEW_FILE" "$REVIEW_PROMPT" </dev/null >/dev/null \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort medium </dev/null >"$REVIEW_FILE" \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort high </dev/null >"$REVIEW_FILE"
node ${RECORD_REVIEW_SCRIPT} ${t.taskStateRoot} ${t.planFile} ${t.number} UPDATE_TASK_ENTRY <"$REVIEW_FILE"
\`\`\`\`

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Use the exact JSON shape given by \`${REVIEW_PLAN_OUTPUT_TEMPLATE_PATH}\`, which the read-file skill put into your context. 
Replace every <...> with a real value. 
Copy what the node command printed; never decide a verdict yourself.`;
}
