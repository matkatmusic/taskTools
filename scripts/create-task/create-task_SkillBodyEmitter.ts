import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowScriptPath = fileURLToPath(new URL("../../skills/create-task/createTask.workflow.js", import.meta.url));
const agentPromptEmitterPath = fileURLToPath(new URL("./create-task_AgentPromptEmitter.ts", import.meta.url));
const appendTaskPath = fileURLToPath(new URL("../shared/appendTask.ts", import.meta.url));

export function produceSkillBody(taskDescription: string): string {
    const workflowArgs = JSON.stringify({
        scriptPath: workflowScriptPath,
        args: { agentPromptEmitterPath, taskDescription },
    });
    const body = `Task described by the user: ${taskDescription}

1. Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke \`/grill-me\` instead to refine it.

2. Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's \`hasTests\` field to \`false\` and its \`tests\` field to an empty string. Otherwise set \`hasTests\` to \`true\` and \`tests\` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around. Copy \`schemaVersion\` from the template as is.

3. Write a \`title\`: a short summary of the task.

4. Invoke AskUserQuestion to settle \`goal\` with the user: ask what has to be true for this task to be done. Any conditions you draft are prompts to react to, not answers — expect the user to replace them with their own wording through the Other option, and never record a condition they did not agree to. Then populate \`goal\` with their answer as an ARRAY of strings, one line per entry and no embedded newlines — the brief and \`/view-task\` rejoin them with newlines, so splitting them keeps \`tasks.json\` readable. Each entry starts \`- \` and states one condition a reviewer can confirm without reading the diff: a command that succeeds, output a user can see, a symptom that no longer reproduces. Do not restate the work itself as the goal, and do not repeat the "This task is considered done when all of these are true:" heading — the brief emits it. A "not in scope" line is not a goal; it goes in \`notInScope\` (next step).

4b. Populate \`notInScope\` with an ARRAY of strings, same one-line-per-entry rule, each starting \`- \` and naming what is explicitly NOT in scope and which sibling task owns it instead — those boundaries stop a reviewer reading a deliberate handoff as an omission. Settle it with the user in the same AskUserQuestion as \`goal\`. The field is required: \`appendTask.ts\` refuses a payload without it.

5. Invoke AskUserQuestion to ask the user exactly: "what problem is being solved by this task". Store the user's answer verbatim, never reworded or summarized, in a \`problemSolvedByTask\` field.

6. Populate \`chainGoal\` only when this task is one of a chain of related tasks: an ARRAY of strings, same one-line-per-entry rule, saying what the whole chain achieves and which task numbers belong to it. Omit the field entirely for a standalone task.

7. Run the workflow with this call, ready to paste:

WORKFLOW: ${workflowArgs}

8. Pipe the merged payload into \`appendTask.ts\`, combining the user-settled \`title\`, \`userDescription\`, \`goal\`, \`hasTests\`, \`tests\`, \`schemaVersion\`, \`problemSolvedByTask\`, \`notInScope\`, and optional \`chainGoal\` with the workflow's \`files\`, \`description\`, \`difficulty\`, and \`blockedBy\`. Populate \`userDescription\` with the task description verbatim, exactly as typed — never edit, summarize, or reword it. If the request names the source note/handoff file(s) the task came from (e.g. an \`update-tasks\` harvest), also include \`"handoffFilePaths": [<those repo-relative paths>]\` in the object; otherwise omit the field. Run this with Bash, with the payload filled in:

node "${appendTaskPath}" <<'APPENDTASKEOF'
<payload JSON here>
APPENDTASKEOF

9. Skip this oversized-task assessment entirely when this invocation carries the marker \`[split-task-child]\` — that marker means \`/split-task\` is creating one of an already-requested set of children, and offering another split here would stop \`/split-task\` from collecting exactly \`numSplits\` child task numbers. Otherwise, assess whether this task is oversized: would the workflow's returned difficulty be 7 or higher, or does its description read as a list of many enumerated steps rather than one piece of work? If so, invoke AskUserQuestion offering two choices: create this task as a single task, or create it and immediately split it into smaller tasks. If the user chooses to split, invoke AskUserQuestion once more to get an integer number of children, at least 2. After the task is appended and its task number is known, invoke \`/split-task <thisTaskNumber> <numSplits>\` immediately, and let its own closing confirmation replace step 11 below.

10. If \`specs/SPEC.md\` exists and this task belongs to one of its spec items, append the task number to that item's \`Tasks:\` line.

11. Finally, confirm to the user: the task number and title that were added.
`;
    return body;
}

function readStdin(): string {
    try {
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

function fail(problem: string): never {
    process.stderr.write(
        `create-task_SkillBodyEmitter: ${problem}\n` +
            `usage: node create-task_SkillBodyEmitter.ts <<'CREATETASKEOF'\n<task description>\nCREATETASKEOF\n`,
    );
    process.exit(1);
}

if (process.argv[1]?.endsWith("create-task_SkillBodyEmitter.ts")) {
    const taskDescription = readStdin().replace(/\n$/, "");
    if (taskDescription === "") {
        fail("no arguments on stdin");
    }
    process.stdout.write(produceSkillBody(taskDescription));
}
