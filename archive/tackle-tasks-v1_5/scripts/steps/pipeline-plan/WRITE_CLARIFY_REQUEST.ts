// WRITE_CLARIFY_REQUEST, from pipeline-plan.mmd
// mutating: writes tasks.json's clarifyRequest field and raises the run's "clarify" attempt counter.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";
import { raiseAttemptCount } from "../../tackle-tasks/taskRunState.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    clarifyRequest: string;
};

// Ported from scripts/tackle-tasks/writeClarifyRequest.ts, the box's old home.
function writeClarifyRequest(projectRoot: string, taskNumber: number, clarifyRequest: string): void {
    const root = requireAbsolutePath("projectRoot", projectRoot);
    const trimmed = clarifyRequest.trim();
    if (trimmed === "") throw new Error(`write-clarify-request: task ${taskNumber} sent an empty request`);

    const pair = resolveTaskFiles(root);
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task: any) => task.taskNumber === taskNumber);
        if (!entry) throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
        (entry as any).clarifyRequest = trimmed;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
}

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    writeClarifyRequest(parsed.projectRoot, parsed.taskNumber, parsed.clarifyRequest);
    raiseAttemptCount(parsed.taskNumber, parsed.runId, "clarify", parsed.projectRoot);
    return {
        box: "WRITE_CLARIFY_REQUEST",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        worktree: parsed.worktree,
        sourceBranch: parsed.sourceBranch,
        projectRoot: parsed.projectRoot,
        clarifyRequest: parsed.clarifyRequest,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
