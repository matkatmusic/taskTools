// The tackle-tasks skill body: one workflow launch, with the task number and the tasks file the preamble reads.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTaskNumberArgument, parseStartingBlockArgument, repositoryTopLevel } from "./resolveTaskRun.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { generateWorkflow } from "../../generateWorkflow.ts";

const TASK_WORKFLOW_PATH = fileURLToPath(new URL("../../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));

// const RESET_TASK_PATH = fileURLToPath(new URL("../resetTask.ts", import.meta.url)); // retired: the hook runs the reset now.

export const skillBody = (argsValue: string, projectRoot: string): string => {
    // `reset N [BLOCK]`: the run-step hook already ran the reset on this prompt and injected its lines above.
    const tokens = argsValue.trim().split(/\s+/);
    if (tokens[0] === "reset") {
        parseTaskNumberArgument(tokens[1] ?? "");
        return `The hook ran the reset for task ${tokens[1]}. Say the lines it injected above. Run nothing.\n`;
    }
    // retired: // ponytail: one task at a time for now — multiple tasks come later.
    const taskNumbers = parseTaskNumberArgument(argsValue);
    /* retired: the hook walks the preamble from PREAMBLE_TASK_NUMBER_INPUT now, so the body runs none of it.
    const run = resolveTaskRun(argsValue, projectRoot);
    const preambleResult = runPreamble(taskNumber, run.runId, projectRoot);
    if (preambleResult.code === WorkflowResultCodes.DO_NOT_PROCEED) {
        const entry = exitTypeNoteNoWriteInput(JSON.stringify({ exitType: preambleResult.exitType, exitNote: preambleResult.reason }));
        const reported = reportExitTypeNoWrite(JSON.stringify(entry));
        return `Say: '${taskNumber} ${reported.exitNote as string}'\n`;
    }
    */

    // Made fresh on every run, so the shapes in it always match the diagrams on disk.
    generateWorkflow(TASK_WORKFLOW_PATH);
    const startingBlock = parseStartingBlockArgument(argsValue);
    const workflowLines = taskNumbers.map((taskNumber, index) => {
        const workflowArgs: Record<string, unknown> = {
            task: taskNumber,
            tasksFile: resolveTaskFiles(projectRoot).tasksPath,
            // firstPassSchemaCount: retired — the workflow reads AGENT_SCHEMAS by block key now.
        };
        if (startingBlock !== "") workflowArgs.startingBlock = startingBlock;
        // Serialized, never interpolated: the arguments may hold quotes, backslashes and newlines.
        const workflowCall = JSON.stringify({
            scriptPath: TASK_WORKFLOW_PATH,
            args: workflowArgs,
        });
        return `WORKFLOW ${index + 1}: ${workflowCall}`;
    });
    const executeCalls = taskNumbers.map((_taskNumber, index) => `\`Workflow(WORKFLOW ${index + 1})\``).join(", ");

    return `Launch every one of the following as a background workflow, in the same message, so they run concurrently:

${workflowLines.join("\n\n")}

execute ${executeCalls} in one message.

Never serialize the runs yourself: each run takes the source-repository lock around its own rebase and merge, and that lock is what makes concurrent merge tails safe.

Wait for every launched run's completion notification, then report one line per task in the order given.
`;
};

/* Retired until the boxes after LAST_BUILT_BOX are wired up again — the v1.5 body:

const SCRIPTS_DIR = fileURLToPath(new URL("./", import.meta.url)).replace(/\/$/, "");
const RESOLVE_WORKFLOW_PATH = fileURLToPath(new URL("../../../skills/tackle-tasks/resolve.workflow.js", import.meta.url));
const TASK_WORKFLOW_PATH = fileURLToPath(new URL("../../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));

    // Serialized, never interpolated: the arguments may hold quotes, backslashes and newlines.
    const resolveCall = JSON.stringify({
        scriptPath: RESOLVE_WORKFLOW_PATH,
        args: { argsValue, scriptsDir: SCRIPTS_DIR },
    });

    return `Run \`Workflow(${resolveCall})\`. It returns \`{taskNumbers, projectRoot, sourceBranch, runId}\` — the requested task numbers, parsed and validated in an isolated agent, plus the run identity every task in this run shares.

Invoke \`/ponytail:ponytail ultra\`.

Then launch one task workflow for every task number in \`taskNumbers\`, in the order given:

\`\`\`
Workflow({"scriptPath": ${JSON.stringify(TASK_WORKFLOW_PATH)}, "args": {"task": <task number>, "projectRoot": <projectRoot>, "sourceBranch": <sourceBranch>, "runId": <runId>, "scriptsDir": ${JSON.stringify(SCRIPTS_DIR)}, "agentPromptEmitterPath": ${JSON.stringify(AGENT_PROMPT_EMITTER_PATH)}}})
\`\`\`

\`projectRoot\`, \`sourceBranch\` and \`runId\` are the resolver's, verbatim, on every launch. Pass nothing else, and never batch two task numbers into one launch.

Launch every one of them as a background workflow, so the tasks run concurrently. Do not build, drive or wait on a merge queue, and never serialize the runs yourself: each run takes the source-repository lock around its own rebase and merge, and that lock is what makes concurrent merge tails safe.

Each run returns \`{task, exitType, exitNote, chainRan}\`. Wait for every launched run's completion notification, then report one line per task:

\`\`\`
Task <task>: <exitType> — <exitNote>
\`\`\`

Report nothing else about a run.

## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the \`commit-message\` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
`;
*/

function readStdin(): string {
    try {
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

if (process.argv[1]?.endsWith("SkillBodyEmitter.ts")) {
    const argsValue = readStdin().replace(/\n$/, "");
    // A brief built from missing arguments points nowhere, so stop rather than emit one.
    if (argsValue === "") {
        process.stderr.write(
            "tackle-tasks SkillBodyEmitter: no arguments on stdin\n" +
                "usage: node SkillBodyEmitter.ts <<'TACKLETASKSEOF'\n[N,N,...]\nTACKLETASKSEOF\n",
        );
        process.exit(1);
    }
    process.stdout.write(skillBody(argsValue, repositoryTopLevel(process.cwd())));
}
