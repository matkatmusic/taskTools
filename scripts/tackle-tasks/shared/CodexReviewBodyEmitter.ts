// Sole home of the "codex reviews the plan" prompt (plans/diagram/pipeline-reviewPlan.mmd); its receipt is the review verdict, typed in planArtifacts.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlanProblem, readAndValidatePlan, type CodexReview } from "./planArtifacts.ts";
import type { PreparedTask } from "./preparedTask.ts";
import { readCheckpoint } from "./checkpoint.ts";
import { getAttemptCount } from "./taskRunState.ts";
import { whatToReturnSection } from "./whatToReturn.ts";
import { codexExecCommand, spawnAgentHeader, spawnClaudeFableCli, spawnClaudeOpus48Cli } from "./spawnAgentCli.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";

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
const WRITE_REVIEW_ANSWER_SCRIPT = fileURLToPath(new URL("./writeReviewAnswer.ts", import.meta.url));

// Serves codex and claude fallbacks alike; drops any owned path not on disk yet.
const reviewedPaths = (t: PreparedTask) => {
    // const plan = readAndValidatePlan(t.planFile, t.number);
    // const root = t.repoRoot.replace(/\/+$/, "");
    // const createdPaths = new Set(isPlanProblem(plan) ? [] : plan.createsFiles.map((file) => `${root}/${file}`));
    // const owned = t.ownedFilePaths.filter((path) => !createdPaths.has(path));
    const owned = t.ownedFilePaths.filter((path) => existsSync(path));
    return [t.briefFile, t.planFile, ...owned, REVIEW_PLAN_TEMPLATE_PATH];
};

// Retired (prompt shapes): three template literals became REVIEW_SECTIONS below, so the skeleton view cannot drift.
// function approveReviewByDefaultPrompt(t: PreparedTask): string {
//     // ACCEPT BY DEFAULT prompt:
//     return `Approve the plan. Do not judge it, do not hunt for problems, and do not flag anything.
//
// Return the JSON shape described below with \`outcome\` set to "OK", with \`missingFiles\`, \`message\`, \`issues\` and \`fixes\` all empty, and with every section \`id\` the plan uses listed in \`sectionsThatHoldUp\`.
//
// ## WHAT YOU READ
//
// ${reviewedPaths(t).map((path) => `- ${path}`).join("\n")}
//
// ## WHAT YOU, THE REVIEWING AGENT, RETURNS
//
// Return only JSON in the shape given by \`${REVIEW_PLAN_TEMPLATE_PATH}\`, which you read above,
// replacing every <...> with a real value.
//
// ## WHAT TO OUTPUT
//
// Print the JSON as your final message and nothing else. The command that runs you captures that
// message to \`${t.reviewOutputFile}\`, so do not try to write the file yourself.
//
// `;
// }
//
// function reviewByDefaultPrompt(t: PreparedTask): string {
//     // REVIEW BY DEFAULT prompt:
//     const adversarial = isCodexDraftedPlan(t);
//     const roleSentence = adversarial
//         ? `You are a second, independent codex instance auditing the implementation plan for task ${t.number}, drafted by another codex instance. Actively hunt for flaws in it; do not extend it the benefit of the doubt.`
//         : `You are a read-only review agent tasked with reviewing the implementation plan for task ${t.number}.`;
//     return `${roleSentence}
// You write no file.
// Your sandbox is read-only, so any attempt to write one fails.
//
// ## STRICT INPUT ALLOWLIST
//
// Read only the exact files listed under WHAT YOU READ.
// Do not search for, list discover, infer, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
// In particular, do not substitute another plan file for plan.json.
//
// You may check whether each listed path exists and is readable.
// Before reviewing, verify every listed file.
// If any file is missing or unreadable, stop immediately without reviewing any other content.
//
// ## MISSING-FILE RESPONSE
//
// If any required file is missing or unreadable, return only the following JSON:
// \`\`\`
// ${readFileSync(REVIEW_PLAN_ERROR_TEMPLATE_PATH, "utf8").trim()}
// \`\`\`
// This error response overrides the normal review-plan JSON template.
// Leave \`"issues"\`, \`"fixes"\` and \`"sectionsThatHoldUp"\` empty.
//
// ## WHAT YOU READ
//
// ${reviewedPaths(t).map((path) => `- ${path}`).join("\n")}
//
// ## SIBLING AND BLOCKER SCOPE
//
// ${t.siblingTasks.length > 0 ? `These tasks share files with task ${t.number} and may own related work:\n${t.siblingTasks.map((s) => `- task ${s.number}: ${s.title}`).join("\n")}` : `No other open task shares files with task ${t.number}.`}
//
// ${t.blockedBy.length > 0 ? `These tasks block task ${t.number}:\n${t.blockedBy.map((b) => `- task ${b.taskNumber} blocks task ${t.number}: ${b.reason}`).join("\n")}` : `No open task blocks task ${t.number}.`}
//
// ${t.blocks.length > 0 ? `Task ${t.number} blocks these tasks:\n${t.blocks.map((b) => `- task ${t.number} blocks task ${b.number}: ${b.reason}`).join("\n")}` : `Task ${t.number} blocks no open task.`}
//
// Work assigned to a named sibling or blocker above is out of scope for task ${t.number} and must not be reported as an omission.
//
// ## HOW TO JUDGE THE PLAN
//
// Check the plan for gotchas, failures, bugs, incorrect assumptions, errors, false statements, or anything that could cause the implementer to fail, waste time, or misunderstand the task.
// Verify every assertion against the source file it is about, never against what the plan says about it.
//
// The brief's \`problemSolvedByTask\` section states the problem this task exists to solve; judge whether the plan solves that problem.
// A task created before that field existed carries no value — the brief then says it is not provided, and you judge against the brief's description instead.
//
// The plan is good enough when an implementer could follow the plan without deciding anything the plan should have already decided:
// - every edit names its file and line numbers with the old and new text,
// - every owned file is either edited or explained as needing no edit,
// - no step is conditional,
// - nothing outside the owned files is touched, and
// - the verification is an exact command with its expected result.
//
// ## DO NOT FLAG
// - file-size or line-count assertions,
// - spelling,
// - grammar,
// - style (coding or prose),
// - trivial formatting, or
// - a change that does not alter the intent of the plan.
// - anything that could be considered "nitpicking".
//
// Flag a small issue **only** when the issue alters the intent of the plan, or when it is a factual error that could mislead an implementer.
//
// ## DOCUMENTING EVIDENCE
//
// Every issue flagged must carry evidence:
// - include the repo-relative path and the exact line numbers you read, as \`path/to/file.ts:12-40\`, when proving an issue exists.
// - A command you ran and its output counts as evidence.
// - An issue you cannot evidence does not go in the review.
//
// If a section holds up, say so and move on.
// - "no issues found" is a valid and useful answer, so never manufacture issues to fill the report.
//
// ## WHAT YOU, THE REVIEWING AGENT, RETURNS
//
// Return only JSON in the shape given by \`${REVIEW_PLAN_TEMPLATE_PATH}\`, which you read above,
// replacing every <...> with a real value.
//
// Write one fix per issue, in the same order.
// Every \`sectionId\` must be an \`id\` the plan actually uses.
// Write each fix as an instruction to whoever repairs the plan, not as commentary about it.
// Your fixes exist to help the task finish, not to block it: tell the planner exactly what to change so the plan proves the implementation solves the problem the task is meant to solve.
// Return empty arrays when you found nothing.
//
// ## A REJECTION IS YOUR FAILURE
//
// You have no reject verdict: your fix count is the verdict. Five or more fixes force a full rewrite round.
// A fix the planner cannot apply exactly as written stalls the task without moving it — that is you failing your job, not the planner failing theirs.
// When you believe the whole approach is wrong, say so as ONE fix stating the approach to take instead, never as a pile of fixes that buys a round but gives no direction.  The approach you provide should be clear, easy to follow, and solve the problem the task is meant to solve.
//
// ## WHAT TO OUTPUT
//
// Print the JSON as your final message and nothing else. The command that runs you captures that
// message to \`${t.reviewOutputFile}\`, so do not try to write the file yourself.
// `;
// }
//
// function recheckOnlyPrompt(t: PreparedTask): string {
//     // RECHECK ONLY prompt: round two rechecks round one's flagged issues, and stops hunting for new ones.
//     return `You are a read-only review agent rechecking the implementation plan for task ${t.number}.
// You write no file.
// Your sandbox is read-only, so any attempt to write one fails.
//
// ## STRICT INPUT ALLOWLIST
//
// Read only the exact files listed under WHAT YOU READ.
// Do not search for, list, discover, infer, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
// In particular, do not substitute another plan file for plan.json.
//
// You may check whether each listed path exists and is readable.
// Before reviewing, verify every listed file.
// If any file is missing or unreadable, stop immediately without reviewing any other content.
//
// ## MISSING-FILE RESPONSE
//
// If any required file is missing or unreadable, return only the following JSON:
// \`\`\`
// ${readFileSync(REVIEW_PLAN_ERROR_TEMPLATE_PATH, "utf8").trim()}
// \`\`\`
// This error response overrides the normal review-plan JSON template.
// Leave \`"issues"\`, \`"fixes"\` and \`"sectionsThatHoldUp"\` empty.
//
// ## WHAT YOU READ
//
// ${[...reviewedPaths(t), t.reviewOutputFile].map((path) => `- ${path}`).join("\n")}
//
// ## HOW TO JUDGE THE PLAN
//
// \`${t.reviewOutputFile}\` is the audit you wrote in round one. check to see if ONLY the issues you flagged in the audit were resolved. Do not look for new issues in the descriptions.
//
// ## DOCUMENTING EVIDENCE
//
// Every issue flagged must carry evidence:
// - include the repo-relative path and the exact line numbers you read, as \`path/to/file.ts:12-40\`, when proving an issue exists.
// - A command you ran and its output counts as evidence.
// - An issue you cannot evidence does not go in the review.
//
// ## WHAT YOU, THE REVIEWING AGENT, RETURNS
//
// Return only JSON in the shape given by \`${REVIEW_PLAN_TEMPLATE_PATH}\`, which you read above,
// replacing every <...> with a real value.
//
// Write one fix only for an audited issue that is still unresolved, in the same order the audit lists them.
// Every \`sectionId\` must be an \`id\` the plan actually uses.
// Write each fix as an instruction to whoever repairs the plan, not as commentary about it.
// Return empty arrays when every audited issue is resolved.
//
// ## WHAT TO OUTPUT
//
// Print the JSON as your final message and nothing else. The command that runs you captures that
// message to \`${t.reviewOutputFile}\`, so do not try to write the file yourself.
// `;
// }
//
// // The relaunch after a plan-scrapped exit gets the approve prompt, so codex's review stops blocking the task.
// export function reviewQuestion(t: PreparedTask): string {
//     if (readCheckpoint(t.repoRoot)?.resumedFrom?.exitType === "plan-scrapped") return approveReviewByDefaultPrompt(t);
//     if (getAttemptCount(t.number, "planReview", t.taskStateRoot) >= 1) return recheckOnlyPrompt(t);
//     return reviewByDefaultPrompt(t);
// }

// The three inputs that pick which shape reviewQuestion's prompt takes.
export type ReviewChoices = { variant: "approve" | "recheck" | "reviewByDefault"; adversarial: boolean };

// Every value spliced into the prompt; the skeleton view passes each one as its expression text instead.
export type ReviewVars = {
    number: string;
    reviewOutputFile: string;
    reviewPlanTemplatePath: string;
    reviewedPaths: string;
    reviewedPathsWithOutput: string;
    errorTemplate: string;
    siblingsText: string;
    blockedByText: string;
    blocksText: string;
};

export type ReviewSection = { name: string; when: (c: ReviewChoices) => boolean; render: (v: ReviewVars) => string };

export const REVIEW_SECTIONS: ReviewSection[] = [
    {
        name: "ROLE: adversarial (reviewByDefault)",
        when: (c) => c.variant === "reviewByDefault" && c.adversarial,
        render: (v) => `You are a second, independent codex instance auditing the implementation plan for task ${v.number}, drafted by another codex instance.
Actively hunt for flaws in the plan.
Do not extend the plan the benefit of the doubt.
You write no file.
Your sandbox is read-only, so any attempt to write one fails.

`,
    },
    {
        name: "ROLE: ordinary (reviewByDefault)",
        when: (c) => c.variant === "reviewByDefault" && !c.adversarial,
        render: (v) => `You are a read-only review agent tasked with reviewing the implementation plan for task ${v.number}.
You write no file.
Your sandbox is read-only, so any attempt to write one fails.

`,
    },
    {
        name: "ROLE: recheck",
        when: (c) => c.variant === "recheck",
        render: (v) => `You are a read-only review agent rechecking the implementation plan for task ${v.number}.
You write no file.
Your sandbox is read-only, so any attempt to write one fails.

`,
    },
    {
        name: "APPROVE: intro",
        when: (c) => c.variant === "approve",
        render: (v) => `Approve the plan.
Do not judge the plan.
Do not hunt for problems in the plan.
Do not flag anything in the plan.

Return the JSON shape described under **WHAT YOU, THE REVIEWING AGENT, RETURNS** below.
Set \`outcome\` to \`"OK"\`.
Leave \`missingFiles\` empty.
Leave \`message\` empty.
Leave \`issues\` empty.
Leave \`fixes\` empty.
List every section \`id\` the plan uses in \`sectionsThatHoldUp\`.

`,
    },
    {
        name: "STRICT INPUT ALLOWLIST: reviewByDefault",
        when: (c) => c.variant === "reviewByDefault",
        render: () => `## STRICT INPUT ALLOWLIST

Read only the exact files listed under WHAT YOU READ. 
Do not search for, list discover, infer, or open alternative files, even if an alternative has a similar name or appears to contain the requested material. 
In particular, do not substitute another plan file for plan.json.

You may check whether each listed path exists and is readable. 
Before reviewing, verify every listed file.
If any file is missing or unreadable, stop immediately without reviewing any other content.

`,
    },
    {
        name: "STRICT INPUT ALLOWLIST: recheck",
        when: (c) => c.variant === "recheck",
        render: () => `## STRICT INPUT ALLOWLIST

Read only the exact files listed under WHAT YOU READ.
Do not search for, list, discover, infer, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
In particular, do not substitute another plan file for plan.json.

You may check whether each listed path exists and is readable.
Before reviewing, verify every listed file.
If any file is missing or unreadable, stop immediately without reviewing any other content.

`,
    },
    {
        name: "MISSING-FILE RESPONSE: reviewByDefault",
        when: (c) => c.variant === "reviewByDefault",
        render: (v) => `## MISSING-FILE RESPONSE

If any required file is missing or unreadable, return only the following JSON:
\`\`\`
${v.errorTemplate}
\`\`\`
This error response overrides the normal review-plan JSON template. 
Leave \`"issues"\`, \`"fixes"\` and \`"sectionsThatHoldUp"\` empty.

`,
    },
    {
        name: "MISSING-FILE RESPONSE: recheck",
        when: (c) => c.variant === "recheck",
        render: (v) => `## MISSING-FILE RESPONSE

If any required file is missing or unreadable, return only the following JSON:
\`\`\`
${v.errorTemplate}
\`\`\`
This error response overrides the normal review-plan JSON template.
Leave \`"issues"\`, \`"fixes"\` and \`"sectionsThatHoldUp"\` empty.

`,
    },
    {
        name: "WHAT YOU READ: reviewByDefault",
        when: (c) => c.variant === "reviewByDefault",
        render: (v) => `## WHAT YOU READ

${v.reviewedPaths}

`,
    },
    // Retired for approve: unnecessary, the plan is approved by default.
    {
        name: "WHAT YOU READ: recheck",
        when: (c) => c.variant === "recheck",
        render: (v) => `## WHAT YOU READ

${v.reviewedPathsWithOutput}

`,
    },
    {
        name: "SIBLING AND BLOCKER SCOPE",
        when: (c) => c.variant === "reviewByDefault",
        render: (v) => `## SIBLING AND BLOCKER SCOPE

${v.siblingsText}

${v.blockedByText}

${v.blocksText}

Work assigned to a named sibling or blocker above is out of scope for task ${v.number} and must not be reported as an omission.

`,
    },
    {
        name: "HOW TO JUDGE THE PLAN: reviewByDefault",
        when: (c) => c.variant === "reviewByDefault",
        render: () => `## HOW TO JUDGE THE PLAN

Check the plan for gotchas, failures, bugs, incorrect assumptions, errors, false statements, or anything that could cause the implementer to fail, waste time, or misunderstand the task.
Verify every assertion against the source file it is about, never against what the plan says about it.

The brief's \`problemSolvedByTask\` section states the problem this task exists to solve.
Judge whether the plan solves that problem.
A task created before that field existed carries no value.
The brief then says it is not provided.
You judge against the brief's description instead.

The plan is good enough when an implementer could follow the plan without deciding anything the plan should have already decided: 
- every edit names its file and line numbers with the old and new text, 
- every owned file is either edited or explained as needing no edit, 
- no step is conditional, 
- nothing outside the owned files is touched, and 
- the verification is an exact command with its expected result.

`,
    },
    {
        name: "HOW TO JUDGE THE PLAN: recheck",
        when: (c) => c.variant === "recheck",
        render: (v) => `## HOW TO JUDGE THE PLAN

\`${v.reviewOutputFile}\` is the audit you wrote in round one.
Check to see if ONLY the issues you flagged in the audit were resolved.
Do not look for new issues in the descriptions.

`,
    },
    {
        name: "DO NOT FLAG",
        when: (c) => c.variant === "reviewByDefault",
        render: () => `## DO NOT FLAG 
- file-size or line-count assertions, 
- spelling, 
- grammar, 
- style (coding or prose), 
- trivial formatting, or 
- a change that does not alter the intent of the plan. 
- anything that could be considered "nitpicking".

Flag a small issue **only** when the issue alters the intent of the plan, or when it is a factual error that could mislead an implementer.

`,
    },
    {
        name: "DOCUMENTING EVIDENCE: reviewByDefault",
        when: (c) => c.variant === "reviewByDefault",
        render: () => `## DOCUMENTING EVIDENCE

Every issue flagged must carry evidence: 
- include the repo-relative path and the exact line numbers you read, as \`path/to/file.ts:12-40\`, when proving an issue exists.
- A command you ran and its output counts as evidence. 
- An issue you cannot evidence does not go in the review. 

If a section holds up, say so and move on.
- "no issues found" is a valid and useful answer, so never manufacture issues to fill the report.

`,
    },
    {
        name: "DOCUMENTING EVIDENCE: recheck",
        when: (c) => c.variant === "recheck",
        render: () => `## DOCUMENTING EVIDENCE

Every issue flagged must carry evidence:
- include the repo-relative path and the exact line numbers you read, as \`path/to/file.ts:12-40\`, when proving an issue exists.
- A command you ran and its output counts as evidence.
- An issue you cannot evidence does not go in the review.

`,
    },
    {
        name: "A REJECTION IS YOUR FAILURE",
        when: (c) => c.variant === "reviewByDefault",
        render: () => `## A REJECTION IS YOUR FAILURE

You have no reject verdict.
Your fix count is the verdict.
Five or more fixes force a full rewrite round.
A fix the planner cannot apply exactly as written stalls the task without moving it.
That is you failing your job, not the planner failing theirs.
When you believe the whole approach is wrong, say so as ONE fix stating the approach to take instead, never as a pile of fixes that buys a round but gives no direction.
The approach you provide should be clear, easy to follow, and solve the problem the task is meant to solve.

`,
    },
    {
        name: "WHAT YOU, THE REVIEWING AGENT, RETURNS: approve",
        when: (c) => c.variant === "approve",
        render: (v) => `## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${v.reviewPlanTemplatePath}\`, replacing every <...> with a real value.

`,
    },
    {
        name: "WHAT YOU, THE REVIEWING AGENT, RETURNS: reviewByDefault",
        when: (c) => c.variant === "reviewByDefault",
        render: (v) => `## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${v.reviewPlanTemplatePath}\`, which you read above, replacing every <...> with a real value.

Write one fix per issue, in the same order.
Every \`sectionId\` must be an \`id\` the plan actually uses.
Write each fix as an instruction to whoever repairs the plan, not as commentary about it.
Your fixes exist to help the task finish, not to block it.
Tell the planner exactly what to change so the plan proves the implementation solves the problem the task is meant to solve.
Return empty arrays when you found nothing.

`,
    },
    {
        name: "WHAT YOU, THE REVIEWING AGENT, RETURNS: recheck",
        when: (c) => c.variant === "recheck",
        render: (v) => `## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by \`${v.reviewPlanTemplatePath}\`, which you read above, replacing every <...> with a real value.

Write one fix only for an audited issue that is still unresolved, in the same order the audit lists them.
Every \`sectionId\` must be an \`id\` the plan actually uses.
Write each fix as an instruction to whoever repairs the plan, not as commentary about it.
Return empty arrays when every audited issue is resolved.

`,
    },
    {
        name: "WHAT TO OUTPUT: approve",
        when: (c) => c.variant === "approve",
        render: (v) => `## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to \`${v.reviewOutputFile}\`.
Do not try to write the file yourself.
`,
    },
    {
        name: "WHAT TO OUTPUT: reviewByDefault",
        when: (c) => c.variant === "reviewByDefault",
        render: (v) => `## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to \`${v.reviewOutputFile}\`.
Do not try to write the file yourself.
`,
    },
    {
        name: "WHAT TO OUTPUT: recheck",
        when: (c) => c.variant === "recheck",
        render: (v) => `## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to \`${v.reviewOutputFile}\`.
Do not try to write the file yourself.
`,
    },
];

export function reviewChoices(t: PreparedTask): ReviewChoices {
    if (readCheckpoint(t.repoRoot)?.resumedFrom?.exitType === "plan-scrapped") return { variant: "approve", adversarial: false };
    if (getAttemptCount(t.number, "planReview", t.taskStateRoot) >= 1) return { variant: "recheck", adversarial: false };
    return { variant: "reviewByDefault", adversarial: isCodexDraftedPlan(t) };
}

// Each value is the source expression, so the skeleton view names what the rendered view splices in.
export const REVIEW_SKELETON_VARS: ReviewVars = {
    number: "`${t.number}`",
    reviewOutputFile: "`${t.reviewOutputFile}`",
    reviewPlanTemplatePath: "`${REVIEW_PLAN_TEMPLATE_PATH}`",
    reviewedPaths: '`${reviewedPaths(t).map((path) => `- ${path}`).join("\\n")}`',
    reviewedPathsWithOutput: '`${[...reviewedPaths(t), t.reviewOutputFile].map((path) => `- ${path}`).join("\\n")}`',
    errorTemplate: '`${readFileSync(REVIEW_PLAN_ERROR_TEMPLATE_PATH, "utf8").trim()}`',
    siblingsText: '`${t.siblingTasks.length > 0 ? "These tasks share files..." : "No other open task shares files with task " + t.number + "."}`',
    blockedByText: '`${t.blockedBy.length > 0 ? "These tasks block task..." : "No open task blocks task " + t.number + "."}`',
    blocksText: '`${t.blocks.length > 0 ? "Task ... blocks these tasks..." : "Task " + t.number + " blocks no open task."}`',
};

export function renderReviewSections(choices: ReviewChoices, vars: ReviewVars): string {
    return REVIEW_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function reviewQuestionSkeleton(choices: ReviewChoices): string {
    return renderReviewSections(choices, REVIEW_SKELETON_VARS);
}

function reviewVars(t: PreparedTask): ReviewVars {
    return {
        number: String(t.number),
        reviewOutputFile: t.reviewOutputFile,
        reviewPlanTemplatePath: REVIEW_PLAN_TEMPLATE_PATH,
        reviewedPaths: reviewedPaths(t).map((path) => `- ${path}`).join("\n"),
        reviewedPathsWithOutput: [...reviewedPaths(t), t.reviewOutputFile].map((path) => `- ${path}`).join("\n"),
        errorTemplate: readFileSync(REVIEW_PLAN_ERROR_TEMPLATE_PATH, "utf8").trim(),
        siblingsText: t.siblingTasks.length > 0 ? `These tasks share files with task ${t.number} and may own related work:\n${t.siblingTasks.map((s) => `- task ${s.number}: ${s.title}`).join("\n")}` : `No other open task shares files with task ${t.number}.`,
        blockedByText: t.blockedBy.length > 0 ? `These tasks block task ${t.number}:\n${t.blockedBy.map((b) => `- task ${b.taskNumber} blocks task ${t.number}: ${b.reason}`).join("\n")}` : `No open task blocks task ${t.number}.`,
        blocksText: t.blocks.length > 0 ? `Task ${t.number} blocks these tasks:\n${t.blocks.map((b) => `- task ${t.number} blocks task ${b.number}: ${b.reason}`).join("\n")}` : `Task ${t.number} blocks no open task.`,
    };
}

// The relaunch after a plan-scrapped exit gets the approve prompt, so codex's review stops blocking the task.
export function reviewQuestion(t: PreparedTask): string {
    return renderReviewSections(reviewChoices(t), reviewVars(t));
}

// Logs beside the run-log so `tail -f` shows codex working; the hook sets RUN_STEP_LOG.
const codexLogFile = () => process.env.RUN_STEP_LOG!.replace(/run-log\.json$/, "codex-review.log");

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

// Retired (prompt shapes): one template literal became PLAN_REVIEW_SECTIONS below, so the skeleton view cannot drift.
// export function planReviewPrompt(t: PreparedTask): string {
//     return `${spawnAgentHeader("review", true)}
//
// \`\`\`\`sh
// ${createCodexShellInvocation(t)}
// \`\`\`\`
//
// ${whatToReturnSection(`{ "reviewFile": "${t.reviewOutputFile}" }`, "the path \\`$REVIEW_FILE\\` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.")}
// `;
// }

// Replaces whatToReturnSection here: the review file path is already known, so one script writes the packet answer.
function reviewAnswerSection(reviewOutputFile: string): string {
    return `## WHAT YOU, THE SPAWNING AGENT, RETURNS

Run \`node ${WRITE_REVIEW_ANSWER_SCRIPT} "<the outcome.payload path>" ${reviewOutputFile}\`.
Then return the hook output verbatim.
`;
}

// planReviewPrompt has no branching of its own; kept for skeleton/combos parity with the other builder.
export type PlanReviewChoices = Record<string, never>;

export type PlanReviewVars = { spawnAgentHeader: string; shellInvocation: string; whatToReturn: string };

export type PlanReviewSection = { name: string; when: (c: PlanReviewChoices) => boolean; render: (v: PlanReviewVars) => string };

export const PLAN_REVIEW_SECTIONS: PlanReviewSection[] = [
    {
        name: "SPAWN AGENT HEADER",
        when: () => true,
        render: (v) => `${v.spawnAgentHeader}

\`\`\`\`sh
`,
    },
    {
        name: "SHELL INVOCATION",
        when: () => true,
        render: (v) => `${v.shellInvocation}
\`\`\`\`

`,
    },
    {
        name: "WHAT TO RETURN",
        when: () => true,
        render: (v) => `${v.whatToReturn}
`,
    },
];

export function planReviewChoices(): PlanReviewChoices {
    return {};
}

// Each value is the source expression, so the skeleton view names what the rendered view splices in.
export const PLAN_REVIEW_SKELETON_VARS: PlanReviewVars = {
    spawnAgentHeader: '`${spawnAgentHeader("review", true)}`',
    shellInvocation: "`${createCodexShellInvocation(t)}`",
    whatToReturn: "`${reviewAnswerSection(t.reviewOutputFile)}`",
};

export function renderPlanReviewSections(choices: PlanReviewChoices, vars: PlanReviewVars): string {
    return PLAN_REVIEW_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function planReviewPromptSkeleton(choices: PlanReviewChoices): string {
    return renderPlanReviewSections(choices, PLAN_REVIEW_SKELETON_VARS);
}

export function planReviewPrompt(t: PreparedTask): string {
    return renderPlanReviewSections(planReviewChoices(), {
        spawnAgentHeader: spawnAgentHeader("review", true),
        shellInvocation: createCodexShellInvocation(t),
        whatToReturn: reviewAnswerSection(t.reviewOutputFile),
    });
}

// The same hand-built task planPrompt.test.ts uses; repoRoot never exists, so it renders with no live worktree.
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
    testFilePaths: [],
    hasTests: true,
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    siblingTasks: [],
    blockedBy: [],
    blocks: [],
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

type Combo = { name: string; skeleton: string; rendered: string };

// reviewChoices(t) reads a live checkpoint/attempt count; combos build ReviewChoices directly instead.
export function reviewQuestionCombos(): Combo[] {
    const vars = reviewVars(fakeTask);
    const combos: Combo[] = [];
    for (const variant of ["approve", "recheck", "reviewByDefault"] as const) {
        for (const adversarial of [false, true]) {
            const choices: ReviewChoices = { variant, adversarial };
            const name = `variant-${variant}_adversarial-${adversarial}`;
            combos.push({ name, skeleton: reviewQuestionSkeleton(choices), rendered: renderReviewSections(choices, vars) });
        }
    }
    return combos;
}

// Combos stub RUN_STEP_LOG and taskStateRoot, since planReviewPrompt needs both but not a real worktree.
export function planReviewPromptCombos(): Combo[] {
    process.env.RUN_STEP_LOG ??= join(tmpdir(), "codex-review-prompt-combos-run-log.json");
    const taskStateRoot = mkdtempSync(join(tmpdir(), "codex-review-prompt-combos-taskstate-"));
    mkdirSync(join(taskStateRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(taskStateRoot, ".taskTools/tasks.json"), JSON.stringify([{ taskNumber: fakeTask.number }]));
    const task = { ...fakeTask, repoRoot: mkdtempSync(join(tmpdir(), "codex-review-prompt-combos-repo-")), taskStateRoot };
    const choices = planReviewChoices();
    return [{ name: "default", skeleton: planReviewPromptSkeleton(choices), rendered: planReviewPrompt(task) }];
}
