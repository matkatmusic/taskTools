// FIX_THE_CODEBASE_FOR_SUITE, from pipeline-suite.mmd. Prompt block; old home: SuiteFixBodyEmitter.ts.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromptOutputTemplate } from "../../shared/contracts.ts";
import { absolutePathsSection } from "../shared/promptSections.ts";
import { resumedRunSection } from "../shared/resumedRunSection.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";
// import { spawnClaudeCliPrompt } from "../shared/spawnAgentCli.ts"; // retired: the agent follows the prompt itself, no CLI spawn.

type Input = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    exitType: string;
    exitNote: string;
    ownedFilePaths: string[];
    readFilePaths: string[];
    testFilePaths: string[];
    output: string;
};

// Double-quoted for the read-file hook's parser; deduped so an owned test file is not listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

// Retired (prompt shapes): one template literal became SUITE_FIX_SECTIONS below, so the skeleton view cannot drift.
// export function buildSuiteFixPrompt(packet: Input): string {
//     const root = packet.worktree.replace(/\/+$/, "");
//     return `## YOUR JOB
//
// Fix the cause of every failure listed under FAILING SUITE OUTPUT, and change nothing else.
//
// The full test suite in the worktree \`${root}\` is red.
// You are repairing the codebase, never the suite.
// A test that fails is reporting a real defect until you have proved otherwise.
//
// ## WHAT TO READ
//
// Run this, which puts the files into your context without spending a Read tool call, so you can read them all at once:
// \`\`\`
// /read-file ${readFileArgs([...packet.ownedFilePaths, ...packet.testFilePaths])}
// \`\`\`
//
// You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.
//
// ${absolutePathsSection(root)}
//
// ## WHAT YOU MAY EDIT
//
// ${packet.ownedFilePaths.map((path) => `- \`${path}\``).join("\n")}
//
// This list is complete.
// Every other path in the tree belongs to another task, including every test file.
//
// If fixing the cause needs an edit outside this list, make no edit at all and say so.
//
// ${resumedRunSection(root)}
//
// ## HOW TO FIX
//
// 1. Read the failing suite output below and name the single defect behind each failure.
// 2. Fix that defect in the paths listed above.
// 3. Re-run only the individual test that failed, with \`node --test <absolute test path>\`, run inside \`${root}\`.
// 4. Repeat until every listed failure is addressed.
//
// ## FORBIDDEN ACTIONS
//
// You are forbidden from doing any of the following actions:
// - weaken, delete, skip, or stub out a test to make a failure disappear;
// - edit a test file at all;
// - edit any path not listed under WHAT YOU MAY EDIT;
// - add scope or a refactor no listed failure calls for;
// - run the full suite;
// - stage or commit anything by hand;
// - force-push or hard-reset anything you did not create.
//
// Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
// It is not a failure, and it is always better than a guess.
//
// ${whatToReturnSection('{ "fixSummary": "..." }', "where \\`fixSummary\\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why", "")}
//
// ## FAILING SUITE OUTPUT
//
// \`\`\`
// ${packet.output}
// \`\`\``;
// }

export type SuiteFixChoices = {};

export type SuiteFixVars = {
    root: string;
    readFileArgs: string;
    absolutePaths: string;
    ownedPaths: string;
    resumedRun: string;
    whatToReturn: string;
    output: string;
};

export type SuiteFixSection = { name: string; when: (c: SuiteFixChoices) => boolean; render: (v: SuiteFixVars) => string };

export const SUITE_FIX_SECTIONS: SuiteFixSection[] = [
    {
        name: "YOUR JOB",
        when: () => true,
        render: (v) => `## YOUR JOB

You are repairing the codebase, never the suite.

The full test suite in the worktree \`${v.root}\` is red.
A test that fails is reporting a real defect until you have proved otherwise.

Fix the cause of every failure listed under FAILING SUITE OUTPUT.
Change nothing else.

`,
    },
    {
        name: "WHAT TO READ",
        when: () => true,
        render: (v) => `## WHAT TO READ

invoke this skill exactly:
\`\`\`
/read-file ${v.readFileArgs}
\`\`\`
The skill puts the owned files and the test files into your context without spending a Read tool call.

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

${v.absolutePaths}

`,
    },
    {
        name: "WHAT YOU MAY EDIT",
        when: () => true,
        // Retired: "list is complete" and cross-task file warning; tasks now run in separate worktrees.
        render: (v) => `## WHAT YOU MAY EDIT

${v.ownedPaths}

If fixing the cause needs an edit outside the WHAT YOU MAY EDIT list, make no edit at all and say so.

${v.resumedRun === "" ? "" : `${v.resumedRun}\n\n`}`,
    },
    {
        name: "HOW TO FIX",
        when: () => true,
        render: (v) => `## HOW TO FIX

1. Read the failing suite output below.
2. Name the single defect behind each failure.
3. Fix that defect in the paths listed above.
4. Re-run only the individual test that failed, with \`node --test <absolute test path>\`, run inside \`${v.root}\`.
5. Repeat until every listed failure is addressed.

`,
    },
    {
        name: "FORBIDDEN ACTIONS",
        when: () => true,
        // Retired (task 51): the fenced hook and disallowedTools now deny editing, testing, and git actions.
        render: () => `## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file at all;
- add scope or a refactor no listed failure calls for.

Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
Leaving a failure unaddressed is not a failure.
Leaving a failure unaddressed is always better than a guess.

`,
    },
    {
        name: "WHAT YOU, THE SPAWNING AGENT, RETURNS",
        when: () => true,
        render: (v) => `${v.whatToReturn}

`,
    },
    {
        name: "FAILING SUITE OUTPUT",
        when: () => true,
        render: (v) => `## FAILING SUITE OUTPUT

\`\`\`
${v.output}
\`\`\``,
    },
];

export function suiteFixChoices(): SuiteFixChoices {
    return {};
}

export const SUITE_FIX_SKELETON_VARS: SuiteFixVars = {
    root: "`${root}`",
    readFileArgs: "`${readFileArgs([...packet.readFilePaths, ...packet.testFilePaths])}`",
    absolutePaths: "`${absolutePathsSection(root)}`",
    ownedPaths: '`${packet.ownedFilePaths.map((path) => `- \\`${path}\\``).join("\\n")}`',
    resumedRun: "`${resumedRunSection(root)}`",
    whatToReturn: "`${whatToReturnSection(...)}`",
    output: "`${packet.output}`",
};

export function renderSuiteFixSections(choices: SuiteFixChoices, vars: SuiteFixVars): string {
    return SUITE_FIX_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function buildSuiteFixPromptSkeleton(choices: SuiteFixChoices): string {
    return renderSuiteFixSections(choices, SUITE_FIX_SKELETON_VARS);
}

export function buildSuiteFixPrompt(packet: Input): string {
    const root = packet.worktree.replace(/\/+$/, "");
    return renderSuiteFixSections(suiteFixChoices(), {
        root,
        readFileArgs: readFileArgs([...packet.readFilePaths, ...packet.testFilePaths]),
        absolutePaths: absolutePathsSection(root),
        ownedPaths: packet.ownedFilePaths.map((path) => `- \`${path}\``).join("\n"),
        resumedRun: resumedRunSection(root),
        whatToReturn: whatToReturnSection('{ "fixSummary": "..." }', "where \\`fixSummary\\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why", ""),
        output: packet.output,
    });
}

export function suiteFixPromptCombos(): { name: string; skeleton: string; rendered: string }[] {
    const fakePacket: Input = {
        box: "ARE_2_SUITE_FIXES_DONE_Q",
        scriptSignal: "continue",
        taskNumber: 1,
        runId: "run-1",
        projectRoot: "/root",
        worktree: "/tmp/fake-worktree",
        branch: "main",
        exitType: "",
        exitNote: "",
        ownedFilePaths: ["/tmp/fake-worktree/a.ts"],
        readFilePaths: ["/tmp/fake-worktree/a.ts"],
        testFilePaths: ["/tmp/fake-worktree/tests/a.test.ts"],
        output: "the failing suite text",
    };
    const c = suiteFixChoices();
    return [{ name: "default", skeleton: buildSuiteFixPromptSkeleton(c), rendered: buildSuiteFixPrompt(fakePacket) }];
}

// const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.md$/, "-agents.log");

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const promptFile = `${packet.worktree.replace(/\/+$/, "")}/plans/FIX_THE_CODEBASE_FOR_SUITE.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, buildSuiteFixPrompt(packet));
    // const prompt = spawnClaudeCliPrompt(...): retired, the workflow agent reads the prompt file and follows it.
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { ...buildPromptOutputTemplate("FIX_THE_CODEBASE_FOR_SUITE"), prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
