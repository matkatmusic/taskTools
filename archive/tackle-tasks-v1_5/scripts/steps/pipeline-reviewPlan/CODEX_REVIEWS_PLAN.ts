// CODEX_REVIEWS_PLAN, from pipeline-reviewPlan.mmd. Ported from scripts/tackle-tasks/CodexReviewBodyEmitter.ts.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
// import { isPlanProblem, readAndValidatePlan } from "../../tackle-tasks/planArtifacts.ts";
import { reviewQuestion } from "../../tackle-tasks/CodexReviewBodyEmitter.ts";
import { loadPreparedTask, type PreparedTask } from "../../tackle-tasks/preparedTask.ts";

export type CodexReviewsPlanPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    briefFile: string;
    planFile: string;
    reviewOutputFile: string;
    ownedFilePaths: string[];
};

// const REVIEW_PLAN_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-plan-template.json", import.meta.url));
const REVIEW_PLAN_SCHEMA_PATH = fileURLToPath(new URL("../../../plans/review-plan-schema.json", import.meta.url));
// const REVIEW_PLAN_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-plan-error-template.json", import.meta.url));

/* Retired: reviewedPaths and reviewQuestion moved to CodexReviewBodyEmitter.ts, the single source of the review text.

// Serves codex and claude fallbacks alike; drops a createsFiles path since it doesn't exist yet.
function reviewedPaths(t: CodexReviewsPlanPacket): string[] {
    const plan = readAndValidatePlan(t.planFile, t.taskNumber);
    if (isPlanProblem(plan)) throw new Error(plan.problem);
    const root = t.repoRoot.replace(/\/+$/, "");
    const createdPaths = new Set(plan.createsFiles.map((file) => `${root}/${file}`));
    const owned = t.ownedFilePaths.filter((path) => !createdPaths.has(path));
    return [t.briefFile, t.planFile, ...owned, REVIEW_PLAN_TEMPLATE_PATH];
}

function reviewQuestion(t: CodexReviewsPlanPacket): string {
    return `You are a read-only review agent tasked with reviewing the implementation plan for task ${t.taskNumber}.
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
Verify every assertion against the source file it is about, never against what the plan says about it.

The plan is good enough when an implementer could follow the plan without deciding anything the plan should have already decided:
- every edit names its file and line numbers with the old and new text,
- every owned file is either edited or explained as needing no edit,
- no step is conditional,
- nothing outside the owned files is touched, and
- the verification is an exact command with its expected result.

## DO NOT FLAG
- file-size or line-count assertions,
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
*/

function planReviewPrompt(t: PreparedTask): string {
    const promptFile = `${t.repoRoot}/plans/CODEX_REVIEWS_PLAN.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, reviewQuestion(t));
    return `You are spawning a review agent running in the CLI.
You do not edit any files; Your job is to run the following command, and return exactly what was printed, in a specific JSON shape.
The command runs a reviewing agent against a plan file.

## THE COMMAND

Run the following multi-line command using Bash(), verbatim, as one single call. It takes a few
minutes; wait for it rather than abandoning it. \`</dev/null\` matters — codex hangs forever
waiting on stdin without it. \`-o\` keeps codex from mixing its banner into the answer, and \`--output-schema\` makes it bare JSON.

\`\`\`\`sh
REVIEW_PROMPT=$(cat "${promptFile}")
REVIEW_FILE=${t.reviewOutputFile}
codex exec -s read-only --output-schema ${REVIEW_PLAN_SCHEMA_PATH} -o "$REVIEW_FILE" "$REVIEW_PROMPT" </dev/null >/dev/null \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort medium </dev/null >"$REVIEW_FILE" \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort high </dev/null >"$REVIEW_FILE"
\`\`\`\`

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Return \`{ "reviewFile": "${t.reviewOutputFile}" }\` — the path \`$REVIEW_FILE\` was set to, never its contents.

If the command above could not be run at all, return that same path anyway; the next block reads the file and fails loudly when it is missing or unusable.
`;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CodexReviewsPlanPacket;
    const t = loadPreparedTask(packet.taskNumber, packet.repoRoot, packet.taskStateRoot);
    return { box: "CODEX_REVIEWS_PLAN", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: planReviewPrompt(t) };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
