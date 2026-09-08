// The planner agent's prompt, shared between the old AgentPromptEmitter dispatch and the pipeline-plan.mmd run-step block (scripts/steps/pipeline-plan/PLAN_THE_TASK.ts).
// import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { absolutePathsSection } from "./promptSections.ts";
// Retired (task 11): only used by the dead `extra.planReview` field below.
// import type { PlanReview } from "./recordPlanReview.ts";
import { resumedRunSection } from "./resumedRunSection.ts";
import { whatToReturnSection } from "./whatToReturn.ts";

// Retired (prompt audit): TESTS_FIELD rules now live as bullets in PLAN REQUIREMENTS.

// Double-quoted for the read-file hook's parser, not a shell: a quoted run keeps a spaced path whole.
const readFileArgs = (paths: string[]) => paths.map((path) => `"${path}"`).join(" ");

const PLAN_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/plan-template.json", import.meta.url));
// Resolved here because the read-file hook stats the raw string and never expands a tilde.
const GUIDE = (name: string) => `${homedir()}/.claude/guides/${name}`;

// Retired (task 11): each only fed clarifyRequestBlock/planReviewBlock/updateDocsBlock below, all now retired.
// const WRITE_CLARIFY_REQUEST_PATH = fileURLToPath(new URL("./writeClarifyRequest.ts", import.meta.url));
// const RECORD_PLAN_REVIEW_PATH = fileURLToPath(new URL("./recordPlanReview.ts", import.meta.url));
// const UPDATE_TASK_DOCS_PATH = fileURLToPath(new URL("./updateTaskDocs.ts", import.meta.url));

// Retired (task 11): only planReviewBlock below called this.
// // Its own copy, so this file never imports the dispatch hub.
// const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

// Retired (task 11): no live caller has set any of these fields since commit 8849857.
// // Set only by the box that ran, telling the next agent to run the matching script first.
// export type PlanPromptExtra = {
//     clarifyRequest?: string;
//     planReview?: PlanReview;
//     updateDocs?: true;
// };

// Retired (task 11): dead since commit 8849857, no live caller passes extra.clarifyRequest.
// const clarifyRequestBlock = (t: PreparedTask, clarifyRequest: string): string => {
//     const payload = JSON.stringify({ projectRoot: t.taskStateRoot, taskNumber: t.number, clarifyRequest, boxId: "WRITE_CLARIFY_REQUEST" });
//     return `Run this first, before doing anything else, exactly as written:
// node ${WRITE_CLARIFY_REQUEST_PATH} <<'TTCLARIFY'
// ${payload}
// TTCLARIFY
//
// `;
// };

// Retired (task 11): dead since commit 8849857, no live caller passes extra.planReview.
// const planReviewBlock = (t: PreparedTask, planReview: PlanReview): string => {
//     const payload = JSON.stringify(planReview);
//     return `Run this first, before doing anything else, exactly as written:
// node ${RECORD_PLAN_REVIEW_PATH} ${shellQuote(t.taskStateRoot)} ${shellQuote(t.planFile)} ${t.number} UPDATE_TASK_ENTRY <<'TTREVIEW'
// ${payload}
// TTREVIEW
//
// `;
// };

// Retired (task 11): dead since commit 8849857, no live caller passes extra.updateDocs.
// const updateDocsBlock = (t: PreparedTask): string => {
//     const payload = JSON.stringify({ taskNumber: t.number, worktreePath: t.repoRoot, projectRoot: t.taskStateRoot, boxId: "UPDATE_AUTO_GENERATED_DOCS" });
//     return `Run this first, before doing anything else, exactly as written:
// node ${UPDATE_TASK_DOCS_PATH} <<'TTDOCS'
// ${payload}
// TTDOCS
//
// `;
// };

// Retired: the prompt now reads plans/plan-template.json through /read-file instead of pasting it.
// const planShape = (t: PreparedTask) => {
//     const shape = JSON.parse(readFileSync(PLAN_TEMPLATE_PATH, "utf8"));
//     shape.task = t.number;
//     return JSON.stringify(shape, null, 2);
// };

// ---------------------------------------------------------------------------
// plan — writes plan.json in the shape of plans/plan-template.json, spliced in below.
// ---------------------------------------------------------------------------

// Retired (prompt shapes): one template literal became PLAN_SECTIONS below, so the skeleton view cannot drift.
// export function planPrompt(t: PreparedTask): string {
//     // Retired (task 11): the extra param (clarifyRequest/planReview/updateDocs) had no live caller.
//     // const leadingBlocks =
//     //     (extra?.clarifyRequest !== undefined ? clarifyRequestBlock(t, extra.clarifyRequest) : "") +
//     //     (extra?.planReview !== undefined ? planReviewBlock(t, extra.planReview) : "") +
//     //     (extra?.updateDocs ? updateDocsBlock(t) : "");
//     const codexNotes = t.codexReviewNotes.trim() === "" ? "" : `
// ## CODEX'S PREVIOUS REVIEW NOTES
//
// Codex reviewed your last plan and did not accept it. Its notes are as follows:
//
// ${t.codexReviewNotes.trim()}
//
// Address every point above in the sections you write.
// `;
//     // Retired (task 11): leadingBlocks no longer exists (1g above); this line dropped its interpolation.
//     // return `${leadingBlocks}${codexNotes}## YOUR JOB`
//     return `${codexNotes}## YOUR JOB
//
// You are a read-only agent that is writing an implementation plan for task ${t.number} from \`.taskTools/tasks.json\`.
// The full task brief is below.
//
// ## DESIRED OUTPUT
// The plan must be written to exactly \`${t.planFile}\`.
// The plan must be formatted in the exact shape shown under **FORMATTING THE PLAN** below.
//
// ## WHAT TO READ:
//
// Run this, which puts the brief, the files this task owns, the guides you must follow,
// and the return shape you must produce into your context:
// \`\`\`
// /read-file ${readFileArgs([t.briefFile, ...t.ownedFilePaths, GUIDE("planning.md"), GUIDE("tdd.md")])}
// \`\`\`
//
// ${absolutePathsSection(t.repoRoot)}
//
// Read the owned files — a plan that guesses at their contents will be rejected.
// The task description may name identifiers, files, or shapes it expects to exist; it was written before other tasks landed. Treat every such name as unverified: search the owned files for it before you plan against it. When a name is not there, plan against what the code holds now and say in the plan which name the description got wrong.
// Follow \`~/.claude/guides/planning.md\` and write the plan as JSON to exactly \`${t.planFile}\`
// Do not change any source file — this is planning only, not implementation.
//
// ${resumedRunSection(t.repoRoot)}
//
// ## FORMATTING THE PLAN
//
// Run this, which puts the exact shape the plan must take into your context:
// \`\`\`
// /read-file ${readFileArgs([PLAN_TEMPLATE_PATH])}
// \`\`\`
// Write the plan in exactly that shape, replacing every \`<...>\` with a real value, with \`task\` set to ${t.number}.
// The file must be strict JSON: inside every string, escape each double quote as \`\\"\`, each backslash as \`\\\\\`, and each newline as \`\\n\`. Before you return, run \`node -e 'JSON.parse(require("fs").readFileSync("${t.planFile}","utf8"))'\` and fix the file until that command prints nothing.
//
// ## PLAN REQUIREMENTS
//
// The plan must be exact enough and comprehensive enough that the implementer makes no discovery of its own:
// - Name every edit by file path and line number.
// - - Show each edit as a \`diff\`: mark each edit as \`old\`, \`new\`.
// - - show the exact text to remove or insert
// - - sort the edits per file as highest line numbers first so edits do not shift the lines of later edits.
// - - Never say "insert at the end" or "replace the whole file" — show the exact text to remove and insert, and where.
// - Account for every file this task owns: either its exact edit list, or the reason it needs no edit.
// - Fill in \`createsFiles\` with every owned file that does not exist yet on disk. Leave it empty when the plan creates nothing new.
// - Resolve every question while planning.
// - Write no conditional instruction
// - no "re-check",
// - no "verify before editing",
// - no "if the live file disagrees",
// - no "trust the live file".
// - If you could not settle something, return outcome CLARIFY, not a fallback sentence in the plan.
// - Quote only text you actually read.
// - Never describe an excerpt the brief does not contain.
// - State the verification that proves the change worked, by writing the exact command used to produce the expected result.  This helps the implementer know that they're implementing correctly.
// - ${TESTS_FIELD_INSTRUCTION}
//
// ## ANSWERING A LEFT-BEHIND CLARIFY REQUEST
//
// The brief may hold a \`clarifyRequest\` field: a question a previous planning round asked.
// When it does, answer the question yourself, from the code, before you plan:
// - Read the files the question names, plus the files this task owns.
// - Trace the live path (the code that runs today), not the task text.
// - Use the answer to write the plan; put the file paths the answer rests on into the plan.
// Return outcome CLARIFY again only when the answer is a decision only the user can make
// (naming choices, tradeoffs, product scope — nothing the code can resolve).
//
// ## WHEN TO STOP PLANNING
//
// If:
// - the plan needs to edit a file this task does not own, OR
// - the plan needs to READ a file you were not given to write an exact plan, OR
// - the task is unclear or no longer applies to the codebase:
//
// Then:
// - do not write the plan file.
// - Instead return outcome CLARIFY, with clarifyRequest naming exactly what you were not given.
//
// Otherwise:
// - write the plan file exactly at \`${t.planFile}\`
// - return outcome PLAN.
//
// ## FORBIDDEN ACTIONS
//
// You are forbidden from doing any of the following actions:
// - edit any file other than \`${t.planFile}\`;
// - to leave a decision for the implementer;
// - to write a plan step whose exact target you did not read.
//
// ## ALLOWED ACTIONS
//
// ${t.readOnlyFiles.includes("*")
//     ? "You are allowed to read any file in the repository. Read what you need; never return CLARIFY just to ask for a file to read."
//     : `You are allowed to read every file the read-file skill put into your context, these read-only files: ${t.readOnlyFiles.join(", ")}, plus every file named by a \`clarifyRequest\` in the brief, and nothing else.
// Files named by the brief's \`clarifyRequest\` count as files you were given.`}
//
// ---- TESTS_FIELD ("skip" means no TDD requirement) ----
// ${t.hasTests ? (t.tests ?? "(the task has tests; the user wrote no example)") : "skip"}
//
// ${whatToReturnSection(`{ "outcome": "<PLAN|CLARIFY>", "planFile": "${t.planFile}", "clarifyRequest": "<the question to ask; an empty string when outcome is PLAN, never null>" }`, "replacing every `<...>` with a real value", "")}`;
// }

// The three inputs that change the planner prompt's text.
export type PlanChoices = { hasCodexNotes: boolean; readsAnyFile: boolean; testsField: "skip" | "userExample" | "noExample" };

// Every value spliced into the prompt; the skeleton view passes each one as its expression text instead.
export type PlanVars = {
    number: string;
    planFile: string;
    codexNotes: string;
    planningReadFileArgs: string;
    absolutePaths: string;
    resumedRun: string;
    templateReadFileArgs: string;
    readOnlyFiles: string;
    tests: string;
    whatToReturn: string;
    // JSON array copied from the task record; the plan's createsFiles must equal it.
    createsFiles: string;
    // "" when difficulty <= 3, where no Codex plan review runs.
    codexPlanReviewLine: string;
    // "" on a first planning round; the repeat-round rule when the task record carries a clarifyRequest.
    repeatClarifyRule: string;
};

export type PlanSection = { name: string; when: (c: PlanChoices) => boolean; render: (v: PlanVars) => string };

export const PLAN_SECTIONS: PlanSection[] = [
    {
        name: "CODEX'S PREVIOUS REVIEW NOTES",
        when: (c) => c.hasCodexNotes,
        render: (v) => `## CODEX'S PREVIOUS REVIEW NOTES

Codex reviewed your last plan.
Codex did not accept it.
Its notes are as follows:

${v.codexNotes}

Address every point above in the sections you write.

`,
    },
    {
        name: "YOUR JOB",
        when: () => true,
        render: (v) => `## YOUR JOB

You are a read-only agent.
You are writing an implementation plan for task ${v.number} from \`.taskTools/tasks.json\`.
The skill under **WHAT TO READ** puts the full task brief into your context.

`,
    },
    {
        name: "DESIRED OUTPUT",
        when: () => true,
        render: (v) => `## DESIRED OUTPUT

The plan must be written to exactly \`${v.planFile}\`.
The plan must be formatted in the exact shape shown under **FORMATTING THE PLAN** below.

`,
    },
    {
        name: "WHAT TO READ",
        when: () => true,
        render: (v) => `## WHAT TO READ

invoke this skill exactly:
\`\`\`
/read-file ${v.planningReadFileArgs}
\`\`\`
The skill puts the brief, the files this task owns, the guides you must follow, and the return shape you must produce into your context.
The files this task owns are the task record's \`modifiableFiles\`.

${v.absolutePaths}

Read the owned files.
A plan that guesses at their contents will be rejected.
The task description may name identifiers, files, or shapes it expects to exist.
The task description was written before other tasks landed.
Treat every such name as unverified.
Search the owned files for each name before you plan against it.
When a name is not there, plan against what the code holds now.
When a name is not there, say in the plan which name the description got wrong.
Follow \`~/.claude/guides/planning.md\`.
Write the plan as JSON to exactly \`${v.planFile}\`.
Do not change any source file.
This is planning only, not implementation.

${v.resumedRun === "" ? "" : `${v.resumedRun}\n\n`}`,
    },
    {
        name: "FORMATTING THE PLAN",
        when: () => true,
        render: (v) => `## FORMATTING THE PLAN

The read-file skill above put \`plan-template.json\`, the exact shape the plan must take, into your context.
Write the plan in exactly that shape.
Replace every \`<...>\` with a real value.
Set \`task\` to ${v.number}.
The file must be strict JSON.
Inside every string, escape each double quote as \`\\"\`.
Inside every string, escape each backslash as \`\\\\\`.
Inside every string, escape each newline as \`\\n\`.
Before you return, run this command:
\`\`\`
node -e 'JSON.parse(require("fs").readFileSync("${v.planFile}","utf8"))'
\`\`\`
Fix the file until that command prints nothing.

`,
    },
    {
        name: "PLAN REQUIREMENTS",
        when: () => true,
        render: (v) => `## PLAN REQUIREMENTS

The plan must be exact enough that the implementer makes no discovery of its own.
The plan must be comprehensive enough that the implementer makes no discovery of its own.
- Name every edit by file path and line number.
- - Show each edit as a \`diff\`.
- - Mark each edit as \`old\` and \`new\`.
- - Show the exact text to remove or insert.
- - Sort the edits per file as highest line numbers first.
- - That order keeps an edit from shifting the lines of a later edit.
- - Never say "insert at the end".
- - Never say "replace the whole file".
- - Show the exact text to remove and insert, and where.
- Account for every file this task owns: either its exact edit list, or the reason it needs no edit.
- Set \`createsFiles\` to exactly \`${v.createsFiles}\`, copied from the task record.
- Never add a file to \`createsFiles\`; a missing file the task does not create is a CLARIFY.
- Resolve every question while planning.
- Write no conditional instruction:
- - no "re-check",
- - no "verify before editing",
- - no "if the live file disagrees",
- - no "trust the live file".
- If you could not settle something, return outcome CLARIFY as described under **WHEN TO STOP PLANNING**.
- Quote only text you actually read.
- Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked.
- - Write the exact command used to produce the expected result.
- - That command tells the implementer that they are implementing correctly.
- When TESTS_FIELD below is the literal string "skip", do not require TDD.
- - Write ordinary verification commands instead.
- When TESTS_FIELD below is not "skip", the task has tests.
- - The plan's verification section must name the concrete tests to write and run.
- When TESTS_FIELD below holds an example test the user wrote, put it in as that check.
- - Expand it with a few extra cases that cover the individual functions it touches.

`,
    },
    {
        name: "ANSWERING A LEFT-BEHIND CLARIFY REQUEST",
        when: () => true,
        render: (v) => `## ANSWERING A LEFT-BEHIND CLARIFY REQUEST

The brief may hold a \`clarifyRequest\` field.
That field is a question a previous planning round asked.
When it is there, answer the question yourself, from the code, before you plan:
- Read the files the question names, plus the files this task owns.
- Trace the live path (the code that runs today), not the task text.
- Use the answer to write the plan.
- Put the file paths the answer rests on into the plan.
Return outcome CLARIFY again only when the answer is a decision only the user can make.
Naming choices, tradeoffs, and product scope are such decisions.
Nothing the code can resolve is such a decision.
${v.repeatClarifyRule}
`,
    },
    {
        name: "WHEN TO STOP PLANNING: any file",
        when: (c) => c.readsAnyFile,
        render: (v) => `## WHEN TO STOP PLANNING

Return outcome CLARIFY when any of these is true:
- the plan needs to edit a file this task does not own;
- the task is unclear;
- the task no longer applies to the codebase.

To return outcome CLARIFY:
- do not write the plan file;
- set \`"outcome"\` to \`"CLARIFY"\` in the object described under **WHAT YOU, THE SPAWNING AGENT, RETURNS**;
- set \`"clarifyRequest"\` to a string naming exactly what you were not given.

Otherwise, return outcome PLAN:
- write the plan file exactly at \`${v.planFile}\`;
- set \`"outcome"\` to \`"PLAN"\` in the object described under **WHAT YOU, THE SPAWNING AGENT, RETURNS**;
- set \`"clarifyRequest"\` to \`""\`.

`,
    },
    {
        name: "WHEN TO STOP PLANNING: listed files",
        when: (c) => !c.readsAnyFile,
        render: (v) => `## WHEN TO STOP PLANNING

Return outcome CLARIFY when any of these is true:
- the plan needs to edit a file this task does not own;
- the plan needs to READ a file you were not given to write an exact plan;
- the task is unclear;
- the task no longer applies to the codebase.

To return outcome CLARIFY:
- do not write the plan file;
- set \`"outcome"\` to \`"CLARIFY"\` in the object described under **WHAT YOU, THE SPAWNING AGENT, RETURNS**;
- set \`"clarifyRequest"\` to a string naming exactly what you were not given.

Otherwise, return outcome PLAN:
- write the plan file exactly at \`${v.planFile}\`;
- set \`"outcome"\` to \`"PLAN"\` in the object described under **WHAT YOU, THE SPAWNING AGENT, RETURNS**;
- set \`"clarifyRequest"\` to \`""\`.

`,
    },
    {
        name: "FORBIDDEN ACTIONS",
        when: () => true,
        render: (v) => `## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- edit any file other than \`${v.planFile}\`;
- leave a decision for the implementer;
- write a plan step whose exact target you did not read.
${v.codexPlanReviewLine}
`,
    },
    {
        name: "ALLOWED ACTIONS: any file",
        when: (c) => c.readsAnyFile,
        render: () => `## ALLOWED ACTIONS

You are allowed to read any file in the repository.
Read what you need.
Never return CLARIFY just to ask for a file to read.

`,
    },
    {
        name: "ALLOWED ACTIONS: listed files",
        when: (c) => !c.readsAnyFile,
        render: (v) => `## ALLOWED ACTIONS

You are allowed to read every file the read-file skill put into your context.
You are allowed to read these read-only files: ${v.readOnlyFiles}.
You are allowed to read every file named by a \`clarifyRequest\` in the brief.
You are allowed to read nothing else.
Files named by the brief's \`clarifyRequest\` count as files you were given.

`,
    },
    {
        name: "TESTS_FIELD: skip",
        when: (c) => c.testsField === "skip",
        render: () => `---- TESTS_FIELD ("skip" means no TDD requirement) ----
skip

`,
    },
    {
        name: "TESTS_FIELD: user example",
        when: (c) => c.testsField === "userExample",
        render: (v) => `---- TESTS_FIELD ("skip" means no TDD requirement) ----
${v.tests}

`,
    },
    {
        name: "TESTS_FIELD: no example",
        when: (c) => c.testsField === "noExample",
        render: () => `---- TESTS_FIELD ("skip" means no TDD requirement) ----
(the task has tests; the user wrote no example)

`,
    },
    {
        name: "WHAT YOU, THE SPAWNING AGENT, RETURNS",
        when: () => true,
        render: (v) => v.whatToReturn,
    },
];

export function planChoices(t: PreparedTask): PlanChoices {
    return {
        hasCodexNotes: t.codexReviewNotes.trim() !== "",
        readsAnyFile: t.readOnlyFiles.includes("*"),
        testsField: !t.hasTests ? "skip" : t.tests === null ? "noExample" : "userExample",
    };
}

// Each value is the source expression, so the skeleton view names what the rendered view splices in.
export const PLAN_SKELETON_VARS: PlanVars = {
    number: "`${t.number}`",
    planFile: "`${t.planFile}`",
    codexNotes: "`${t.codexReviewNotes.trim()}`",
    planningReadFileArgs: '`${readFileArgs([t.briefFile, ...t.readFilePaths, GUIDE("planning.md"), GUIDE("tdd.md"), PLAN_TEMPLATE_PATH])}`',
    absolutePaths: "`${absolutePathsSection(t.repoRoot)}`",
    resumedRun: "`${resumedRunSection(t.repoRoot)}`",
    templateReadFileArgs: "`${readFileArgs([PLAN_TEMPLATE_PATH])}`",
    readOnlyFiles: '`${t.readOnlyFiles.join(", ")}`',
    tests: "`${t.tests}`",
    whatToReturn: "`${whatToReturnSection(...)}`",
    createsFiles: "`${JSON.stringify(t.createsFiles)}`",
    codexPlanReviewLine: "`${t.difficulty <= 3 ? \"\" : CODEX_PLAN_REVIEW_LINE}`",
    repeatClarifyRule: "`${t.clarifyRequest === \"\" ? \"\" : REPEAT_CLARIFY_RULE}`",
};

const CODEX_PLAN_REVIEW_LINE = "The Codex plan review rejects any plan step whose target the plan does not quote from a file you read.\n";

const REPEAT_CLARIFY_RULE = `This is a repeat round: the brief's \`clarifyRequest\` was already asked and no user answered it.
Do not ask the same question again; re-asking it with more evidence returns the same silence.
Either answer it from the code and return PLAN, or return CLARIFY with a different question.
`;

export function renderPlanSections(choices: PlanChoices, vars: PlanVars): string {
    return PLAN_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function planPromptSkeleton(choices: PlanChoices): string {
    return renderPlanSections(choices, PLAN_SKELETON_VARS);
}

export function planPrompt(t: PreparedTask): string {
    return renderPlanSections(planChoices(t), {
        number: String(t.number),
        planFile: t.planFile,
        codexNotes: t.codexReviewNotes.trim(),
        planningReadFileArgs: readFileArgs([t.briefFile, ...t.readFilePaths, GUIDE("planning.md"), GUIDE("tdd.md"), PLAN_TEMPLATE_PATH]),
        absolutePaths: absolutePathsSection(t.repoRoot),
        resumedRun: resumedRunSection(t.repoRoot),
        templateReadFileArgs: readFileArgs([PLAN_TEMPLATE_PATH]),
        readOnlyFiles: t.readOnlyFiles.join(", "),
        tests: t.tests ?? "",
        whatToReturn: whatToReturnSection(`{ "outcome": "<PLAN|CLARIFY>", "planFile": "${t.planFile}", "clarifyRequest": "<the question to ask; an empty string when outcome is PLAN, never null>" }`, "replacing every `<...>` with a real value", ""),
        createsFiles: JSON.stringify(t.createsFiles),
        codexPlanReviewLine: t.difficulty <= 3 ? "" : CODEX_PLAN_REVIEW_LINE,
        repeatClarifyRule: t.clarifyRequest === "" ? "" : REPEAT_CLARIFY_RULE,
    });
}
