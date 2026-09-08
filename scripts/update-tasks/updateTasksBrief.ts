import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const extractOpenSectionsPath = fileURLToPath(new URL("../shared/extractOpenSections.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("../shared/getTaskDetails.ts", import.meta.url));
const nextTaskNumberPath = fileURLToPath(new URL("../shared/nextTaskNumber.ts", import.meta.url));
const archiveProcessedPath = fileURLToPath(new URL("../shared/archiveProcessed.ts", import.meta.url));

const filesToProcess = execFileSync("node", [extractOpenSectionsPath, "--list"], { encoding: "utf8" }).trimEnd();
const extractedSections = execFileSync("node", [extractOpenSectionsPath], { encoding: "utf8" }).trimEnd();
const titles = execFileSync("node", [getTaskDetailsPath], { encoding: "utf8" }).trimEnd();

export const brief = `First, invoke \`/ponytail:ponytail ultra\`.

Then:

1. Files to process: ${filesToProcess}

2. Extracted open-work sections (every \`### Open questions\` section from implementation notes, the \`## What Remains\` section from handoffs; each under a \`=== <file> ===\` banner): 
${extractedSections}


   Apply judgment to the extracted text above: skip items the section itself marks as resolved (e.g. "None blocking"), and skip empty sections.

3.  **De-duplicate.** Before adding, check both \`tasks.json\` and \`completedTasks.json\` (titles and descriptions) for an existing task covering the same item. If an open item belongs to an existing open task, extend that task's \`description\` (and add the source file to its \`handoffFilePaths\`) instead of creating a duplicate — the extended description must still come in under ten sentences, so condense or replace existing text rather than only appending.
Titles: ${titles}

4. **Create each new task via the \`create-task\` skill** — one Skill-tool invocation per task, sequentially (each invocation injects the then-current next taskNumber). Pass as args: a short title, the open item in the source file's own wording (with enough context to act on it later — file paths, item numbers), and the source file's **archived** path (e.g. \`plans/archived/implementation-notes-item66-fork-style-port.md\`) to record as \`handoffFilePaths\`. The wording is already refined here — create-task should not need AskUserQuestion. If the Skill tool is unavailable, append directly to \`tasks.json\` in the same format instead (\`taskNumber\` = run \`node "${nextTaskNumberPath}"\` before each append, \`title\`, \`description\`, \`handoffFilePaths\`; omit completion-related fields).

5. **Archive the processed files**: run \`node "${archiveProcessedPath}" <the step-1 file list>\`. It moves each given file into \`plans/archived/\` (a file that yielded no new tasks is still retired by processing it) and leaves any file in place whose name already exists in \`plans/archived/\`, printing \`COLLISION\` for it — report those collisions.

Finally, report a short table: each archived file → the task numbers created from it (or "none / duplicate of task N"). 
Stage the changes but do not commit. Invoke the \`commit-message\` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
`;

if (process.argv[1]?.endsWith("updateTasksBrief.ts")) {
  process.stdout.write(brief);
}
