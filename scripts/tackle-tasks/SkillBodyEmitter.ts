// The tackle-tasks skill body: paths only, plus the preamble that can replace it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPreamble } from "./PreambleDataEmitter.ts";
import { repositoryTopLevel, resolveTaskRun } from "./resolveTaskRun.ts";
import { WorkflowResultCodes } from "./WorkflowResultCodes.ts";
import { main as exitTypeNoteNoWriteInput } from "../steps/pipeline-reportOnlyExit/EXIT_TYPE_NOTE_NO_WRITE_INPUT.ts";
import { main as reportExitTypeNoWrite } from "../steps/pipeline-reportOnlyExit/REPORT_EXIT_TYPE_NO_WRITE.ts";

const AGENT_PROMPT_EMITTER_PATH = fileURLToPath(new URL("./AgentPromptEmitter.ts", import.meta.url));
const TASK_WORKFLOW_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));

export const skillBody = (argsValue: string, projectRoot: string): string => {
    // ponytail: one task at a time for now — multiple tasks come later.
    const run = resolveTaskRun(argsValue, projectRoot);
    const [taskNumber] = run.taskNumbers;
    const preambleResult = runPreamble(taskNumber, run.runId, projectRoot);
    if (preambleResult.code === WorkflowResultCodes.DO_NOT_PROCEED) {
        // migrated to scripts/steps/pipeline-reportOnlyExit/{EXIT_TYPE_NOTE_NO_WRITE_INPUT,REPORT_EXIT_TYPE_NO_WRITE,STOP}.ts
        // return `Say: '${taskNumber} ${preambleResult.reason}'\n`;
        const entry = exitTypeNoteNoWriteInput(JSON.stringify({ exitType: preambleResult.exitType, exitNote: preambleResult.reason }));
        const reported = reportExitTypeNoWrite(JSON.stringify(entry));
        return `Say: '${taskNumber} ${reported.exitNote as string}'\n`;
    }

    // Serialized, never interpolated: the arguments may hold quotes, backslashes and newlines.
    const workflowCall = JSON.stringify({
        scriptPath: TASK_WORKFLOW_PATH,
        args: {
            task: taskNumber,
            agentPromptEmitterPath: AGENT_PROMPT_EMITTER_PATH,
            // AgentPromptEmitter's CLI rejects a payload missing any of these four.
            worktree: preambleResult.receipt!.worktree,
            projectRoot,
            sourceBranch: run.sourceBranch,
            runId: run.runId,
        },
    });

    return `WORKFLOW: ${workflowCall}

execute \`Workflow(WORKFLOW)\`
`;
};

/* Retired until the boxes after LAST_BUILT_BOX are wired up again — the v1.5 body:

const SCRIPTS_DIR = fileURLToPath(new URL("./", import.meta.url)).replace(/\/$/, "");
const RESOLVE_WORKFLOW_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/resolve.workflow.js", import.meta.url));
const TASK_WORKFLOW_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));

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
