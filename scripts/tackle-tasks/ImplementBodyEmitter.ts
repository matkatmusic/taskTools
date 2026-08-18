// Sole home of the implement prompt, the "implement task" box in plans/diagram/pipeline-implement.mmd.
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { absolutePathsSection } from "./promptSections.ts";

// Its own copy, so this file never imports the dispatch hub and the imports stay one-way.
const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

// Double-quoted for the read-file hook's parser; deduped so an owned test file is not listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

const IMPLEMENT_OUTPUT_PATH = fileURLToPath(new URL("../../plans/implement-output-template.json", import.meta.url));
// Resolved here because the read-file hook stats the raw string and never expands a tilde.
const GUIDE = (name: string) => `${homedir()}/.claude/guides/${name}`;

const ownedPathMap = (t: PreparedTask) => t.files
    .map((file) => `- \`${file}\` => \`${t.repoRoot.replace(/\/+$/, "")}/${file}\``)
    .join("\n");

export function implementPrompt(t: PreparedTask, note: string, typecheckCommand: string, maxFixRounds: number): string {
    const rootedTypecheck = `(cd -- ${shellQuote(t.repoRoot)} && ${typecheckCommand})`;
    const runNote = note.trim() === "" ? "" : `
## NOTE FOR THIS RUN

${note.trim()}
`;
    return `Invoke the skill \`/ponytail:ponytail ultra\` first.
${runNote}
## YOUR JOB

You are implementing exactly one pre-planned task, task ${t.number}, inside the worktree \`${t.repoRoot}\`.
The plan is already written and already reviewed. 
Decide nothing the plan already decided.

## WHAT TO READ

Invoke the following skill verbatim:
\`\`\`
/read-file ${readFileArgs([t.briefFile, t.planFile, ...t.ownedFilePaths, ...t.testFilePaths, GUIDE("coding-standards.md"), GUIDE("tdd.md"), IMPLEMENT_OUTPUT_PATH])}
\`\`\`
This skill puts the files into your context without spending a Read tool call, so you can read them all at once.

## OBEY THE REVIEW NOTES

Every section of the plan carries a \`codexNotes\` field. 
An empty \`codexNotes\` means the section stands as written.

If a section's \`codexNotes\` is not empty, a reviewer wrote a required fix for that section.
When a \`codexNotes\` field is not empty, do what the field says while you implement that section. 

${absolutePathsSection(t.repoRoot)}

## WHAT YOU MAY EDIT

${ownedPathMap(t)}
- the implementation log at \`${t.notesFile}\`
- the test file paired with each owned file, at \`${t.repoRoot}/tests/<owned file's base name>.test.ts\`

You are forbidden from editing any other file not listed above.

## TESTS

Each owned file is paired with \`tests/<its base name>.test.ts\`. 
The paired files that already exist are in your context from the read-file skill above. 
Per \`~/.claude/guides/tdd.md\`, write the failing test before the code that satisfies it.

## HOW TO IMPLEMENT

1. Implement every section of the plan, in the order the \`sections\` array gives them, editing only the paths listed above.
2. Run \`${rootedTypecheck}\` and fix every error it reports in the paths you own.
3. Run each paired test file with \`(cd -- ${shellQuote(t.repoRoot)} && node --test <absolute test path>)\`.
4. While any test fails, fix the cause, then repeat steps 2 and 3. Stop after ${maxFixRounds} rounds.

Never run the full suite. That gate belongs to a separate phase, not to you.

## KEEP AN IMPLEMENTATION LOG

Write a running log to exactly \`${t.notesFile}\`, and update it as you work.
Record only what the plan does not already say, under these four headings:
- Design decisions: a choice you made where the plan was ambiguous.
- Deviations: a place you departed from the plan, and why.
- Tradeoffs: an alternative you considered, and why you rejected it.
- Open questions: anything the user should confirm.

Stamp each entry with an ISO date and time.
You have no user to ask, so never stop and wait for an answer.
An open question that blocks the plan is a reason to return \`implemented: false\`, not a reason to guess.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- edit anything outside the paths listed under WHAT YOU MAY EDIT;
- add scope or a refactor the plan does not call for;
- redecide anything the plan already decided;
- run the full suite;
- stage or commit anything — a later box owns committing;
- run any git command;
- attempt more than ${maxFixRounds} fix rounds;
- return \`implemented: true\` while a test fails or the typecheck reports an error.

Returning \`implemented: false\` is a correct outcome when the plan is impossible as written.

## WHAT TO RETURN

Return the shape given by \`${IMPLEMENT_OUTPUT_PATH}\`, which the read-file skill put into your
context, replacing every \`<...>\` with a real value.`;
}
