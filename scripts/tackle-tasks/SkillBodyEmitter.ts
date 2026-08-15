// The tackle-tasks skill body: paths and prose only, never a subprocess and never task data.
//
// It also runs the preamble, so a failed check replaces the whole body with one line.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPreamble } from "./PreambleDataEmitter.ts";
import { generateRunId } from "../prepareTasks.ts";
import { parseTaskNumberArgument, repositoryTopLevel } from "./resolveTaskRun.ts";
import { WorkflowResultCodes } from "./WorkflowResultCodes.ts";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand.
const withoutTrailingSlash = (path: string): string => path.replace(/\/$/, "");

const SCRIPTS_DIR = withoutTrailingSlash(fileURLToPath(new URL("./", import.meta.url)));
const AGENT_PROMPT_EMITTER_PATH = fileURLToPath(new URL("./AgentPromptEmitter.ts", import.meta.url));
const RESOLVE_WORKFLOW_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/resolve.workflow.js", import.meta.url));
const TASK_WORKFLOW_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));

// The resolver workflow, not this brief, names its script and resolves the project root.
export const skillBody = (argsValue: string, projectRoot: string): string => {
    // ponytail: one task at a time for now — multiple tasks come later.
    const [taskNumber] = parseTaskNumberArgument(argsValue);
    // ponytail: the resolver mints its own runId, so this one only marks the task active.
    const preambleResult = runPreamble(taskNumber, generateRunId(), projectRoot);
    if (preambleResult.code === WorkflowResultCodes.DO_NOT_PROCEED) {
        return `Say: '${taskNumber} ${preambleResult.reason}'\n`;
    }

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
};

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
