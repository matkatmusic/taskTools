// The planner agent's prompt, shared between the old AgentPromptEmitter dispatch and the pipeline-plan.mmd run-step block (scripts/steps/pipeline-plan/PLAN_THE_TASK.ts).
// import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { absolutePathsSection } from "./promptSections.ts";
import type { PlanReview } from "./recordPlanReview.ts";
import { resumedRunSection } from "./resumedRunSection.ts";
import { whatToReturnSection } from "./whatToReturn.ts";

const TESTS_FIELD_INSTRUCTION = `If TESTS_FIELD below is the literal string "skip", do not require TDD; write ordinary
verification commands instead. Otherwise the task has tests: the plan's verification section
must name the concrete tests to write and run. When TESTS_FIELD holds an example test the user
wrote, put it in as that check, expanded with a few extra cases covering the individual
functions/subparts it touches.`;

// Double-quoted for the read-file hook's parser, not a shell: a quoted run keeps a spaced path whole.
const readFileArgs = (paths: string[]) => paths.map((path) => `"${path}"`).join(" ");

const PLAN_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/plan-template.json", import.meta.url));
// Resolved here because the read-file hook stats the raw string and never expands a tilde.
const GUIDE = (name: string) => `${homedir()}/.claude/guides/${name}`;

const WRITE_CLARIFY_REQUEST_PATH = fileURLToPath(new URL("./writeClarifyRequest.ts", import.meta.url));
const RECORD_PLAN_REVIEW_PATH = fileURLToPath(new URL("./recordPlanReview.ts", import.meta.url));
const UPDATE_TASK_DOCS_PATH = fileURLToPath(new URL("./updateTaskDocs.ts", import.meta.url));

// Its own copy, so this file never imports the dispatch hub.
const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

// Set only by the box that ran, telling the next agent to run the matching script first.
export type PlanPromptExtra = {
    clarifyRequest?: string;
    planReview?: PlanReview;
    updateDocs?: true;
};

const clarifyRequestBlock = (t: PreparedTask, clarifyRequest: string): string => {
    const payload = JSON.stringify({ projectRoot: t.taskStateRoot, taskNumber: t.number, clarifyRequest, boxId: "WRITE_CLARIFY_REQUEST" });
    return `Run this first, before doing anything else, exactly as written:
node ${WRITE_CLARIFY_REQUEST_PATH} <<'TTCLARIFY'
${payload}
TTCLARIFY

`;
};

const planReviewBlock = (t: PreparedTask, planReview: PlanReview): string => {
    const payload = JSON.stringify(planReview);
    return `Run this first, before doing anything else, exactly as written:
node ${RECORD_PLAN_REVIEW_PATH} ${shellQuote(t.taskStateRoot)} ${shellQuote(t.planFile)} ${t.number} UPDATE_TASK_ENTRY <<'TTREVIEW'
${payload}
TTREVIEW

`;
};

const updateDocsBlock = (t: PreparedTask): string => {
    const payload = JSON.stringify({ taskNumber: t.number, worktreePath: t.repoRoot, projectRoot: t.taskStateRoot, boxId: "UPDATE_AUTO_GENERATED_DOCS" });
    return `Run this first, before doing anything else, exactly as written:
node ${UPDATE_TASK_DOCS_PATH} <<'TTDOCS'
${payload}
TTDOCS

`;
};

// Retired: the prompt now reads plans/plan-template.json through /read-file instead of pasting it.
// const planShape = (t: PreparedTask) => {
//     const shape = JSON.parse(readFileSync(PLAN_TEMPLATE_PATH, "utf8"));
//     shape.task = t.number;
//     return JSON.stringify(shape, null, 2);
// };

// ---------------------------------------------------------------------------
// plan — writes plan.json in the shape of plans/plan-template.json, spliced in below.
// ---------------------------------------------------------------------------

export function planPrompt(t: PreparedTask, extra?: PlanPromptExtra): string {
    const leadingBlocks =
        (extra?.clarifyRequest !== undefined ? clarifyRequestBlock(t, extra.clarifyRequest) : "") +
        (extra?.planReview !== undefined ? planReviewBlock(t, extra.planReview) : "") +
        (extra?.updateDocs ? updateDocsBlock(t) : "");
    const codexNotes = t.codexReviewNotes.trim() === "" ? "" : `
## CODEX'S PREVIOUS REVIEW NOTES

Codex reviewed your last plan and did not accept it. Its notes are as follows:

${t.codexReviewNotes.trim()}

Address every point above in the sections you write.
`;
    return `${leadingBlocks}${codexNotes}## YOUR JOB

You are a read-only agent that is writing an implementation plan for task ${t.number} from \`.taskTools/tasks.json\`.
The full task brief is below.

## DESIRED OUTPUT
The plan must be written to exactly \`${t.planFile}\`.
The plan must be formatted in the exact shape shown under **FORMATTING THE PLAN** below.

## WHAT TO READ:

Run this, which puts the brief, the files this task owns, the guides you must follow,
and the return shape you must produce into your context:
\`\`\`
/read-file ${readFileArgs([t.briefFile, ...t.ownedFilePaths, GUIDE("planning.md"), GUIDE("tdd.md")])}
\`\`\`

${absolutePathsSection(t.repoRoot)}

Read the owned files — a plan that guesses at their contents will be rejected.
Follow \`~/.claude/guides/planning.md\` and write the plan as JSON to exactly \`${t.planFile}\`
Do not change any source file — this is planning only, not implementation.

${resumedRunSection(t.repoRoot)}

## FORMATTING THE PLAN

Run this, which puts the exact shape the plan must take into your context:
\`\`\`
/read-file ${readFileArgs([PLAN_TEMPLATE_PATH])}
\`\`\`
Write the plan in exactly that shape, replacing every \`<...>\` with a real value, with \`task\` set to ${t.number}.

## PLAN REQUIREMENTS

The plan must be exact enough and comprehensive enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number.
- - Show each edit as a \`diff\`: mark each edit as \`old\`, \`new\`.
- - show the exact text to remove or insert
- - sort the edits per file as highest line numbers first so edits do not shift the lines of later edits.
- - Never say "insert at the end" or "replace the whole file" — show the exact text to remove and insert, and where.
- Account for every file this task owns: either its exact edit list, or the reason it needs no edit.
- Fill in \`createsFiles\` with every owned file that does not exist yet on disk. Leave it empty when the plan creates nothing new.
- Resolve every question while planning.
- Write no conditional instruction
- no "re-check",
- no "verify before editing",
- no "if the live file disagrees",
- no "trust the live file".
- If you could not settle something, return outcome CLARIFY, not a fallback sentence in the plan.
- Quote only text you actually read.
- Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, by writing the exact command used to produce the expected result.  This helps the implementer know that they're implementing correctly.
- ${TESTS_FIELD_INSTRUCTION}

## WHEN TO STOP PLANNING

If:
- the plan needs to edit a file this task does not own, OR
- the plan needs to READ a file you were not given to write an exact plan, OR
- the task is unclear or no longer applies to the codebase:

Then:
- do not write the plan file.
- Instead return outcome CLARIFY, with clarifyRequest naming exactly what you were not given.

Otherwise:
- write the plan file exactly at \`${t.planFile}\`
- return outcome PLAN.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- edit any file other than \`${t.planFile}\`;
- to leave a decision for the implementer;
- to write a plan step whose exact target you did not read.

## ALLOWED ACTIONS

You are allowed to read every file the read-file skill put into your context, and nothing else.

---- TESTS_FIELD ("skip" means no TDD requirement) ----
${t.hasTests ? (t.tests ?? "(the task has tests; the user wrote no example)") : "skip"}

${whatToReturnSection(`{ "outcome": "<PLAN|CLARIFY>", "planFile": "${t.planFile}", "clarifyRequest": "<the question to ask; an empty string when outcome is PLAN, never null>" }`, "replacing every `<...>` with a real value", "")}`;
}
