import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readTaskLists, listTaskTitles } from "../shared/getTaskDetails.ts";

const taskTemplatePath = fileURLToPath(new URL("../../skills/create-task/template/taskTemplate.json", import.meta.url));

export function getOpenTaskLines(): string {
    const { openTasks } = readTaskLists();
    return listTaskTitles("OPEN", openTasks).join("\n");
}

export function produceFileHunterPrompt(taskDescription: string, taskTemplate: string): string {
    return `Find the files this task will touch, and write its description and difficulty.

Populate \`description\` with only the agent's derived understanding gathered while researching this task: file paths, function names, root-cause findings, constraints, and decisions; it must not restate the raw prompt. Keep it under ten sentences — cite code rather than restating it. Do not include line numbers; line numbers grow stale as tasks are completed and the codebase evolves.

Populate \`files\` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

Populate \`difficulty\` on a 1-10 scale measuring implementation effort and risk, not importance: 1 = typo, comment, or constant edit with no behavior change; 10 = wide blast radius, unclear scope, or a previously reverted attempt. The full scale is documented in the template below.

Task described by the user: ${taskDescription}

Template for reference:
${taskTemplate}`;
}

export function produceBlockerHunterPrompt(taskDescription: string, openTaskLines: string): string {
    return `Find which open tasks block this task.

Read the code each open task touches, not only its title — a blocker can be "the function this task needs does not exist yet", which no title match would catch.

Populate \`blockedBy\` with an array of objects, each shaped \`{ taskNumber: <the blocking task's number>, reason: "<required: why this task depends on it>" }\`. An empty array is the correct answer when nothing blocks this task.

Task described by the user: ${taskDescription}

Open tasks:
${openTaskLines}`;
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
        `create-task_AgentPromptEmitter: ${problem}\n` +
            `usage: node create-task_AgentPromptEmitter.ts <files|blockers> <<'CREATETASKEOF'\n<task description>\nCREATETASKEOF\n`,
    );
    process.exit(1);
}

if (process.argv[1]?.endsWith("create-task_AgentPromptEmitter.ts")) {
    const taskDescription = readStdin().replace(/\n$/, "");
    if (taskDescription === "") {
        fail("no task description on stdin");
    }
    const mode = process.argv[2];
    if (mode === "files") {
        const taskTemplate = readFileSync(taskTemplatePath, "utf8").trimEnd();
        process.stdout.write(produceFileHunterPrompt(taskDescription, taskTemplate));
    } else if (mode === "blockers") {
        process.stdout.write(produceBlockerHunterPrompt(taskDescription, getOpenTaskLines()));
    } else {
        fail(`unknown mode ${mode ?? "(none)"}; expected files or blockers`);
    }
}
