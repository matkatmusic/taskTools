// IMPLEMENT_TASK, from pipeline-implement.mmd. COMMIT_IMPLEMENTATION_IF_NEEDED owns committing, not this box.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { loadPreparedTask, type PreparedTask } from "../shared/preparedTask.ts";
import { absolutePathsSection } from "../shared/promptSections.ts";
import { resumedRunSection } from "../shared/resumedRunSection.ts";
// import { spawnClaudeCliPrompt } from "../shared/spawnAgentCli.ts"; // retired: the agent follows the prompt itself, no CLI spawn.
import { whatToReturnSection } from "../shared/whatToReturn.ts";

const GUIDE = (name: string) => `${homedir()}/.claude/guides/${name}`;
const DEFAULT_TYPECHECK_COMMAND = "npx tsc --noEmit";
// ponytail: no sender sets maxFixRounds yet, default until one does.
const DEFAULT_MAX_FIX_ROUNDS = 3;

type ImplementTaskInput = {
    taskNumber: number;
    projectRoot: string;
    worktree: string;
    typecheckCommand?: string;
    maxFixRounds?: number;
};

// Double-quoted for the read-file hook's parser; deduped so an owned test file is not listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

// Retired (prompt shapes): inlined as the "TESTS: skip" / "TESTS: tdd" sections below.
// const testsSection = (t: PreparedTask) => {
//     if (t.tests === "skip" || !t.hasTests) return `## DO NOT CREATE TESTS
//
// this task does not require any tests to be created.`;
//     return `## TESTS
//
// Each owned file is paired with \`tests/<its base name>.test.ts\`.
// The paired files that already exist are in your context from the read-file skill above.
// Import \`test\` from \`node:test\` and \`assert\` from \`node:assert\`; never import from \`bun:test\`.
// Per \`~/.claude/guides/tdd.md\`, write the failing test before the code that satisfies it.`;
// };

const ownedPathMap = (t: PreparedTask) => t.files
    .map((file) => `- \`${file}\` => \`${t.repoRoot.replace(/\/+$/, "")}/${file}\``)
    .join("\n");

// Retired (prompt shapes): one template literal became IMPLEMENT_SECTIONS below, so the skeleton view cannot drift.
// export function buildImplementPrompt(t: PreparedTask, typecheckCommand: string, maxFixRounds: number): string {
//     const rootedTypecheck = `(cd -- '${t.repoRoot}' && ${typecheckCommand})`;
//     const note = t.codexReviewNotes;
//     const runNote = note.trim() === "" ? "" : `
// ## NOTE FOR THIS RUN
//
// ${note.trim()}
// `;
//     return `${runNote}
// ## YOUR JOB
//
// You are implementing exactly one pre-planned task, task ${t.number}, inside the worktree \`${t.repoRoot}\`.
// The plan is already written and already reviewed.
// Decide nothing the plan already decided.
//
// ## WHAT TO READ
//
// Run this, which puts the brief, the plan, the files this task owns, and the guides you must follow into your context:
// \`\`\`
// /read-file ${readFileArgs([t.briefFile, t.planFile, ...t.ownedFilePaths, ...t.testFilePaths, GUIDE("coding-standards.md"), GUIDE("tdd.md")])}
// \`\`\`
//
// ## OBEY THE REVIEW NOTES
//
// Every section of the plan carries a \`codexNotes\` field.
// An empty \`codexNotes\` means the section stands as written.
//
// If a section's \`codexNotes\` is not empty, a reviewer wrote a required fix for that section.
// When a \`codexNotes\` field is not empty, do what the field says while you implement that section.
//
// ${absolutePathsSection(t.repoRoot)}
//
// ## WHAT YOU MAY EDIT
//
// ${ownedPathMap(t)}
// - the implementation log at \`${t.notesFile}\`
// - the test file paired with each owned file, at \`${t.repoRoot}/tests/<owned file's base name>.test.ts\`
//
// You are forbidden from editing any other file not listed above.
//
// ${resumedRunSection(t.repoRoot)}
//
// ${testsSection(t)}
//
// ## HOW TO IMPLEMENT
//
// 1. Implement every section of the plan, in the order the \`sections\` array gives them, editing only the paths listed above.
// 2. Run \`${rootedTypecheck}\` and fix every error it reports in the paths you own.
// 3. Run each paired test file with \`(cd -- '${t.repoRoot}' && node --test <absolute test path>)\`.
// 4. While any test fails, fix the cause, then repeat steps 2 and 3. Stop after ${maxFixRounds} rounds.
//
// Never run the full suite. That gate belongs to a separate phase, not to you.
//
// ## KEEP AN IMPLEMENTATION LOG
//
// Write a running log to exactly \`${t.notesFile}\`, and update it as you work.
// Record only what the plan does not already say, under these four headings:
// - Design decisions: a choice you made where the plan was ambiguous.
// - Deviations: a place you departed from the plan, and why.
// - Tradeoffs: an alternative you considered, and why you rejected it.
// - Open questions: anything the user should confirm.
//
// Stamp each entry with an ISO date and time.
// You have no user to ask, so never stop and wait for an answer.
// An open question that blocks the plan is a reason to return \`implemented: false\`, not a reason to guess.
//
// ## NEVER COMMIT
//
// Never stage, commit, or run any git command. A later step commits your work for you.
//
// ## FORBIDDEN ACTIONS
//
// You are forbidden from doing any of the following actions:
// - edit anything outside the paths listed under WHAT YOU MAY EDIT;
// - add scope or a refactor the plan does not call for;
// - redecide anything the plan already decided;
// - run the full suite;
// - stage or commit anything, or run any git command;
// - attempt more than ${maxFixRounds} fix rounds;
// - return \`implemented: true\` while a test fails or the typecheck reports an error. A test listed in \`.taskTools/knownFailingTests.json\` (the \`npm run test:baseline\` baseline) does not count as failing.
//
// Returning \`implemented: false\` is a correct outcome when the plan is impossible as written.
//
// ${whatToReturnSection('{ "implemented": <true only when every plan step is done, the typecheck is clean and every test passed, false otherwise>, "notes": "<what you implemented; when implemented is false, name what is left and why it stopped>" }', "where \\`message\\` is a one-line summary of what you did", "")}`;
// }

export type ImplementChoices = { hasCodexNotes: boolean; testsField: "skip" | "tdd" };

export type ImplementVars = {
    number: string;
    repoRoot: string;
    planFile: string;
    codexNotes: string;
    readFileArgs: string;
    absolutePaths: string;
    ownedPathMap: string;
    notesFile: string;
    resumedRun: string;
    rootedTypecheck: string;
    maxFixRounds: string;
    whatToReturn: string;
};

export type ImplementSection = { name: string; when: (c: ImplementChoices) => boolean; render: (v: ImplementVars) => string };

export const IMPLEMENT_SECTIONS: ImplementSection[] = [
    {
        name: "NOTE FOR THIS RUN",
        when: (c) => c.hasCodexNotes,
        render: (v) => `## NOTE FOR THIS RUN

${v.codexNotes}

`,
    },
    {
        name: "YOUR JOB",
        when: () => true,
        render: (v) => `## YOUR JOB

You are implementing exactly one pre-planned task, task ${v.number}, inside the worktree \`${v.repoRoot}\`.
The plan is already written and already reviewed.
Decide nothing the plan already decided.

`,
    },
    {
        name: "BEFORE YOU IMPLEMENT",
        when: () => true,
        render: (v) => `## BEFORE YOU IMPLEMENT

invoke this skill exactly:
\`\`\`
/ponytail ultra
\`\`\`

then

invoke this skill exactly:
\`\`\`
/jot:implement ${v.planFile}
\`\`\`

`,
    },
    {
        name: "WHAT TO READ",
        when: () => true,
        // Retired: "Run this, which puts..." phrasing; now uses the rule-5 skill-invocation shape.
        render: (v) => `## WHAT TO READ

invoke this skill exactly:
\`\`\`
/read-file ${v.readFileArgs}
\`\`\`
The skill puts the brief, the plan, the files this task owns, and the guides you must follow into your context.

`,
    },
    {
        name: "OBEY THE REVIEW NOTES",
        when: () => true,
        // Retired: 3 overlapping codexNotes sentences, folded into the line below.
        render: (v) => `## OBEY THE REVIEW NOTES

Do not ignore, and instead follow, any non-empty \`codexNotes\` field in each section of the plan.

${v.absolutePaths}

`,
    },
    {
        name: "WHAT YOU MAY EDIT",
        when: () => true,
        render: (v) => `## WHAT YOU MAY EDIT

${v.ownedPathMap}
- the implementation log at \`${v.notesFile}\`
- the test file paired with each owned file, at \`${v.repoRoot}/tests/<owned file's base name>.test.ts\`

You are forbidden from editing any other file not listed above.

${v.resumedRun === "" ? "" : `${v.resumedRun}\n\n`}`,
    },
    {
        name: "TESTS: skip",
        when: (c) => c.testsField === "skip",
        render: () => `## DO NOT CREATE TESTS

This task does not require any tests to be created.

`,
    },
    {
        name: "TESTS: tdd",
        when: (c) => c.testsField === "tdd",
        render: () => `## TESTS

Each owned file is paired with \`tests/<its base name>.test.ts\`.
The paired files that already exist are in your context from the read-file skill above.
Import \`test\` from \`node:test\`.
Import \`assert\` from \`node:assert\`.
Never import from \`bun:test\`.
Per \`~/.claude/guides/tdd.md\`, write the failing test before the code that satisfies it.

`,
    },
    {
        name: "HOW TO IMPLEMENT",
        when: () => true,
        render: (v) => `## HOW TO IMPLEMENT

1. Implement every section of the plan, in the order the \`sections\` array gives them, editing only the paths listed above.
2. Run \`${v.rootedTypecheck}\`.
Fix every error it reports in the paths you own.
3. Run each paired test file with \`(cd -- '${v.repoRoot}' && node --test <absolute test path>)\`.
4. While any test fails, fix the cause, then repeat steps 2 and 3.
Stop after ${v.maxFixRounds} rounds.

Never run the full suite.
That gate belongs to a separate phase, not to you.

`,
    },
    // Retired: replaced by the /jot:implement invocation under BEFORE YOU IMPLEMENT.
    // {
    //     name: "KEEP AN IMPLEMENTATION LOG",
    //     when: () => true,
    //     render: (v) => `## KEEP AN IMPLEMENTATION LOG
    //
    // Write a running log to exactly \`${v.notesFile}\`, and update it as you work.
    // Record only what the plan does not already say, under these four headings:
    // - Design decisions: a choice you made where the plan was ambiguous.
    // - Deviations: a place you departed from the plan, and why.
    // - Tradeoffs: an alternative you considered, and why you rejected it.
    // - Open questions: anything the user should confirm.
    //
    // Stamp each entry with an ISO date and time.
    // You have no user to ask, so never stop and wait for an answer.
    // An open question that blocks the plan is a reason to return \`implemented: false\`, not a reason to guess.
    //
    // `,
    // },
    {
        name: "NEVER COMMIT",
        when: () => true,
        render: () => `## NEVER COMMIT

Never stage, commit, or run any git command.
A later step commits your work for you.

`,
    },
    {
        name: "FORBIDDEN ACTIONS",
        when: () => true,
        render: (v) => `## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- edit anything outside the paths listed under WHAT YOU MAY EDIT;
- add scope or a refactor the plan does not call for;
- redecide anything the plan already decided;
- run the full suite;
- stage or commit anything, or run any git command;
- attempt more than ${v.maxFixRounds} fix rounds;
- return \`implemented: true\` while a test fails or the typecheck reports an error.
A test listed in \`.taskTools/knownFailingTests.json\` (the \`npm run test:baseline\` baseline) does not count as failing.

Returning \`implemented: false\` is a correct outcome when the plan is impossible as written.

`,
    },
    {
        name: "WHAT YOU, THE SPAWNING AGENT, RETURNS",
        when: () => true,
        render: (v) => v.whatToReturn,
    },
];

export function implementChoices(t: PreparedTask): ImplementChoices {
    return {
        hasCodexNotes: t.codexReviewNotes.trim() !== "",
        testsField: t.tests === "skip" || !t.hasTests ? "skip" : "tdd",
    };
}

export const IMPLEMENT_SKELETON_VARS: ImplementVars = {
    number: "`${t.number}`",
    repoRoot: "`${t.repoRoot}`",
    planFile: "`${t.planFile}`",
    codexNotes: "`${t.codexReviewNotes.trim()}`",
    readFileArgs: '`${readFileArgs([t.briefFile, t.planFile, ...t.ownedFilePaths, ...t.testFilePaths, GUIDE("coding-standards.md"), GUIDE("tdd.md")])}`',
    absolutePaths: "`${absolutePathsSection(t.repoRoot)}`",
    ownedPathMap: "`${ownedPathMap(t)}`",
    notesFile: "`${t.notesFile}`",
    resumedRun: "`${resumedRunSection(t.repoRoot)}`",
    rootedTypecheck: "`${rootedTypecheck}`",
    maxFixRounds: "`${maxFixRounds}`",
    whatToReturn: "`${whatToReturnSection(...)}`",
};

export function renderImplementSections(choices: ImplementChoices, vars: ImplementVars): string {
    return IMPLEMENT_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function buildImplementPromptSkeleton(choices: ImplementChoices): string {
    return renderImplementSections(choices, IMPLEMENT_SKELETON_VARS);
}

export function buildImplementPrompt(t: PreparedTask, typecheckCommand: string, maxFixRounds: number): string {
    const rootedTypecheck = `(cd -- '${t.repoRoot}' && ${typecheckCommand})`;
    return renderImplementSections(implementChoices(t), {
        number: String(t.number),
        repoRoot: t.repoRoot,
        planFile: t.planFile,
        codexNotes: t.codexReviewNotes.trim(),
        readFileArgs: readFileArgs([t.briefFile, t.planFile, ...t.ownedFilePaths, ...t.testFilePaths, GUIDE("coding-standards.md"), GUIDE("tdd.md")]),
        absolutePaths: absolutePathsSection(t.repoRoot),
        ownedPathMap: ownedPathMap(t),
        notesFile: t.notesFile,
        resumedRun: resumedRunSection(t.repoRoot),
        rootedTypecheck,
        maxFixRounds: String(maxFixRounds),
        whatToReturn: whatToReturnSection('{ "implemented": <true only when every plan step is done, the typecheck is clean and every test passed, false otherwise>, "notes": "<what you implemented; when implemented is false, name what is left and why it stopped>" }', "where \\`message\\` is a one-line summary of what you did", ""),
    });
}

export function implementPromptCombos(): { name: string; skeleton: string; rendered: string }[] {
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
    const combos: { name: string; skeleton: string; rendered: string }[] = [];
    for (const codexReviewNotes of ["", "Point one.\nPoint two."]) {
        for (const [hasTests, tests] of [[false, null], [true, "skip"], [true, "node --test tests/thing.test.ts"]] as const) {
            const task = { ...fakeTask, codexReviewNotes, hasTests, tests };
            const c = implementChoices(task);
            const name = `codex-${c.hasCodexNotes ? "notes" : "none"}_tests-${c.testsField}`;
            combos.push({ name, skeleton: buildImplementPromptSkeleton(c), rendered: buildImplementPrompt(task, "npx tsc --noEmit", 3) });
        }
    }
    return combos;
}

// const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.md$/, "-agents.log");

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as ImplementTaskInput;
    const t = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const promptFile = `${packet.worktree.replace(/\/+$/, "")}/plans/IMPLEMENT_TASK.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, buildImplementPrompt(t, packet.typecheckCommand || DEFAULT_TYPECHECK_COMMAND, packet.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS));
    // const prompt = spawnClaudeCliPrompt(...): retired, the workflow agent reads the prompt file and follows it.
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "IMPLEMENT_TASK", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
