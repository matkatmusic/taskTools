// Sole home of the "codex reviews the plan" prompt (plans/diagram/pipeline-reviewPlan.mmd); its receipt is the review verdict, typed in planArtifacts.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPlanProblem, readAndValidatePlan, type CodexReview } from "./planArtifacts.ts";
import type { PreparedTask } from "./preparedTask.ts";
import { readCheckpoint } from "./checkpoint.ts";
import { whatToReturnSection } from "./whatToReturn.ts";
import { codexExecCommand, spawnAgentHeader, spawnClaudeFableCli, spawnClaudeOpus48Cli } from "./spawnAgentCli.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";

// Same difficulty>=7 rule PLAN_THE_TASK.ts uses to route to codex drafting; no field records this separately.
const isCodexDraftedPlan = (t: PreparedTask): boolean => {
    const entry = readTaskFile(resolveTaskFiles(t.taskStateRoot).tasksPath).find((task) => task.taskNumber === t.number);
    return entry !== undefined && Number(entry.difficulty) >= 7;
};

export type CodexReviewReceipt = CodexReview;

// Its own copy, so this file never imports the dispatch hub and the imports stay one-way.
const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

// ---------------------------------------------------------------------------
// review-plan — codex rules on the plan, and a script turns its answer into the verdict.
// ---------------------------------------------------------------------------

const REVIEW_PLAN_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-plan-template.json", import.meta.url));
const REVIEW_PLAN_SCHEMA_PATH = fileURLToPath(new URL("../../../plans/review-plan-schema.json", import.meta.url));
const REVIEW_PLAN_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-plan-error-template.json", import.meta.url));
const REVIEW_PLAN_OUTPUT_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-plan-output-template.json", import.meta.url));
const RECORD_REVIEW_SCRIPT = fileURLToPath(new URL("./recordPlanReview.ts", import.meta.url));

// Serves codex and claude fallbacks alike; drops a createsFiles path since it doesn't exist yet.
const reviewedPaths = (t: PreparedTask) => {
    const plan = readAndValidatePlan(t.planFile, t.number);
    const root = t.repoRoot.replace(/\/+$/, "");
    const createdPaths = new Set(isPlanProblem(plan) ? [] : plan.createsFiles.map((file) => `${root}/${file}`));
    const owned = t.ownedFilePaths.filter((path) => !createdPaths.has(path));
    return [t.briefFile, t.planFile, ...owned, REVIEW_PLAN_TEMPLATE_PATH];
};

function approveReviewByDefaultPrompt(t: PreparedTask): string {
    // ACCEPT BY DEFAULT prompt:
    return `Approve the plan. Do not judge it, do not hunt for problems, and do not flag anything.

Return the JSON shape described below with \`outcome\` set to "OK", with \`missingFiles\`, \`message\`, \`issues\` and \`fixes\` all empty, and with every section \`id\` the plan uses listed in \`sectionsThatHoldUp\`.

## WHAT YOU READ

${reviewedPaths(t).map((path) => `- ${path}`).join("\n")}

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${REVIEW_PLAN_TEMPLATE_PATH}\`, which you read above,
replacing every <...> with a real value.

## WHAT TO OUTPUT 

Print the JSON as your final message and nothing else. The command that runs you captures that
message to \`${t.reviewOutputFile}\`, so do not try to write the file yourself.

`;
}

function reviewByDefaultPrompt(t: PreparedTask): string {
    // REVIEW BY DEFAULT prompt:
    const adversarial = isCodexDraftedPlan(t);
    const roleSentence = adversarial
        ? `You are a second, independent codex instance auditing the implementation plan for task ${t.number}, drafted by another codex instance. Actively hunt for flaws in it; do not extend it the benefit of the doubt.`
        : `You are a read-only review agent tasked with reviewing the implementation plan for task ${t.number}.`;
    return `${roleSentence}
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

The brief's \`problemSolvedByTask\` section states the problem this task exists to solve; judge whether the plan solves that problem.
A task created before that field existed carries no value — the brief then says it is not provided, and you judge against the brief's description instead.

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
Your fixes exist to help the task finish, not to block it: tell the planner exactly what to change so the plan proves the implementation solves the problem the task is meant to solve.
Return empty arrays when you found nothing.

## A REJECTION IS YOUR FAILURE

You have no reject verdict: your fix count is the verdict. Five or more fixes force a full rewrite round.
A fix the planner cannot apply exactly as written stalls the task without moving it — that is you failing your job, not the planner failing theirs.
When you believe the whole approach is wrong, say so as ONE fix stating the approach to take instead, never as a pile of fixes that buys a round but gives no direction.  The approach you provide should be clear, easy to follow, and solve the problem the task is meant to solve.

## WHAT TO OUTPUT 

Print the JSON as your final message and nothing else. The command that runs you captures that
message to \`${t.reviewOutputFile}\`, so do not try to write the file yourself.
`;
}

// The relaunch after a plan-scrapped exit gets the approve prompt, so codex's review stops blocking the task.
export function reviewQuestion(t: PreparedTask): string {
    if (readCheckpoint(t.repoRoot)?.resumedFrom?.exitType === "plan-scrapped") return approveReviewByDefaultPrompt(t);
    return reviewByDefaultPrompt(t);
}

// Logs beside the run-log so `tail -f` shows codex working; the hook sets RUN_STEP_LOG.
const codexLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.json$/, "-codex-review.log");

// Failed experiment: a spawned shell has no controlling terminal, so /dev/tty tricks fail codex before it starts.
function createCodexShellInvocationTTY(t: PreparedTask): string {
    return `REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${reviewQuestion(t)}
REVIEWEOF
)
REVIEW_FILE=${t.reviewOutputFile}

if [ -w /dev/tty ]; then
  exec 3>/dev/tty
else
  exec 3>&2
fi

perl -e 'alarm shift; exec @ARGV' 300 \\
  codex exec \\
    -s read-only \\
    --output-schema ${REVIEW_PLAN_SCHEMA_PATH} \\
    -o "$REVIEW_FILE" \\
    "$REVIEW_PROMPT" \\
    </dev/null >/dev/null 2>&3 \\
  || ${spawnClaudeFableCli("medium")} \\
  || ${spawnClaudeOpus48Cli("high")}

node ${RECORD_REVIEW_SCRIPT} ${t.taskStateRoot} ${t.planFile} ${t.number} UPDATE_TASK_ENTRY <"$REVIEW_FILE"
    `;
}

function createCodexShellInvocationLive(t: PreparedTask): string {
    return `REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${reviewQuestion(t)}
REVIEWEOF
)
REVIEW_FILE=${t.reviewOutputFile}
CODEX_LOG=${codexLogFile()}

${codexExecCommand(REVIEW_PLAN_SCHEMA_PATH)} \\
  || ${spawnClaudeFableCli("medium")} \\
  || ${spawnClaudeOpus48Cli("high")}
    `;
// WHAT_IS_REVIEW_VERDICT already records the review; this line would apply fixes twice.  node ${RECORD_REVIEW_SCRIPT} ${t.taskStateRoot} ${t.planFile} ${t.number} UPDATE_TASK_ENTRY <"$REVIEW_FILE"
}

function createCodexShellInvocationOriginal(t: PreparedTask): string {
    return `REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${reviewQuestion(t)}
REVIEWEOF
)
REVIEW_FILE=${t.reviewOutputFile}
perl -e 'alarm shift; exec @ARGV' 300 codex exec -s read-only --output-schema ${REVIEW_PLAN_SCHEMA_PATH} -o "$REVIEW_FILE" "$REVIEW_PROMPT" </dev/null >/dev/null \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort medium </dev/null >"$REVIEW_FILE" \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort high </dev/null >"$REVIEW_FILE"
node ${RECORD_REVIEW_SCRIPT} ${t.taskStateRoot} ${t.planFile} ${t.number} UPDATE_TASK_ENTRY <"$REVIEW_FILE"
    `;
}

export function createCodexShellInvocation(t: PreparedTask) : string {
    // return createCodexShellInvocationOriginal(t);
    // return createCodexShellInvocationTTY(t);
    return createCodexShellInvocationLive(t);
}

export function planReviewPrompt(t: PreparedTask): string {
    return `${spawnAgentHeader("review", true)}

\`\`\`\`sh
${createCodexShellInvocation(t)}
\`\`\`\`

${whatToReturnSection(`{ "reviewFile": "${t.reviewOutputFile}" }`, "the path \\`$REVIEW_FILE\\` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.")}
`;
}
