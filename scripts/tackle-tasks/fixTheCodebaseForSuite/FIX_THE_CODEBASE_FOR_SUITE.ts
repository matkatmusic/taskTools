// FIX_THE_CODEBASE_FOR_SUITE, from pipeline-suite.mmd. Prompt block; old home: SuiteFixBodyEmitter.ts.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromptOutputTemplate } from "../../contracts.ts";
import { absolutePathsSection } from "../shared/promptSections.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";

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
    testFilePaths: string[];
    output: string;
};

// Double-quoted for the read-file hook's parser; deduped so an owned test file is not listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

function buildSuiteFixPrompt(packet: Input): string {
    const root = packet.worktree.replace(/\/+$/, "");
    return `## YOUR JOB

Fix the cause of every failure listed under FAILING SUITE OUTPUT, and change nothing else.

The full test suite in the worktree \`${root}\` is red.
You are repairing the codebase, never the suite.
A test that fails is reporting a real defect until you have proved otherwise.

## WHAT TO READ

Run this, which puts the files into your context without spending a Read tool call, so you can read them all at once:
\`\`\`
/read-file ${readFileArgs([...packet.ownedFilePaths, ...packet.testFilePaths])}
\`\`\`

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

${absolutePathsSection(root)}

## WHAT YOU MAY EDIT

${packet.ownedFilePaths.map((path) => `- \`${path}\``).join("\n")}

This list is complete.
Every other path in the tree belongs to another task, including every test file.

If fixing the cause needs an edit outside this list, make no edit at all and say so.

## HOW TO FIX

1. Read the failing suite output below and name the single defect behind each failure.
2. Fix that defect in the paths listed above.
3. Re-run only the individual test that failed, with \`node --test <absolute test path>\`, run inside \`${root}\`.
4. Repeat until every listed failure is addressed.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file at all;
- edit any path not listed under WHAT YOU MAY EDIT;
- add scope or a refactor no listed failure calls for;
- run the full suite;
- stage or commit anything by hand;
- force-push or hard-reset anything you did not create.

Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
It is not a failure, and it is always better than a guess.

${whatToReturnSection('{ "fixSummary": "..." }', "where \\`fixSummary\\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why", "")}

## FAILING SUITE OUTPUT

\`\`\`
${packet.output}
\`\`\``;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const promptFile = `${packet.worktree.replace(/\/+$/, "")}/plans/FIX_THE_CODEBASE_FOR_SUITE.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, buildSuiteFixPrompt(packet));
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { ...buildPromptOutputTemplate("FIX_THE_CODEBASE_FOR_SUITE"), prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
