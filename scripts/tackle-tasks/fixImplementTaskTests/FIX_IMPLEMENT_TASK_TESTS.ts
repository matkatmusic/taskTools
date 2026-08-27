// FIX_IMPLEMENT_TASK_TESTS, from pipeline-fixImplementTaskTests.mmd. Prompt block: fix the task's own tests, never the tests themselves.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromptOutputTemplate } from "../../contracts.ts";
import { loadPreparedTask, type PreparedTask } from "../shared/preparedTask.ts";
import { absolutePathsSection } from "../shared/promptSections.ts";
import type { CommitImplementationIfNeededPacket } from "../commitImplementationIfNeeded/_packet.ts";

// Double-quoted for the read-file hook's parser; deduped so a path is never listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

function buildFixTaskTestsPrompt(prepared: PreparedTask): string {
    const root = prepared.repoRoot.replace(/\/+$/, "");
    return `## YOUR JOB

Fix the cause of every failure listed under FAILING TASK TESTS, and change no test.

The task's own tests in the worktree \`${root}\` are red.
You are repairing the codebase, never the tests.
A test that fails is reporting a real defect until you have proved otherwise.

## WHAT TO READ

Run this, which puts the files into your context without spending a Read tool call, so you can read them all at once:
\`\`\`
/read-file ${readFileArgs([...prepared.ownedFilePaths, ...prepared.testFilePaths])}
\`\`\`

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

${absolutePathsSection(root)}

## WHAT YOU MAY EDIT

${prepared.ownedFilePaths.map((path) => `- \`${path}\``).join("\n")}

This list is complete.
Every other path in the tree belongs to another task, including every test file.

If fixing the cause needs an edit outside this list, make no edit at all and say so.

## HOW TO FIX

1. Read the failing test notes below and name the single defect behind each failure.
2. Fix that defect in the paths listed above.
3. Re-run only the individual test that failed, with \`node --test <absolute test path>\`, run inside \`${root}\`.
4. Repeat until every listed failure is addressed.
5. Never run the full suite.

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

## WHAT TO RETURN

Return \`{ "message": "", "additionalData": { "fixSummary": "..." } }\`, where \`fixSummary\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why.

## FAILING TASK TESTS

\`\`\`
${prepared.codexReviewNotes}
\`\`\``;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const promptFile = `${prepared.repoRoot.replace(/\/+$/, "")}/plans/FIX_IMPLEMENT_TASK_TESTS.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, buildFixTaskTestsPrompt(prepared));
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { ...buildPromptOutputTemplate("FIX_IMPLEMENT_TASK_TESTS"), prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
