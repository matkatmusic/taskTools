// FINISHED_IMPLEMENTATION_INPUT, from pipeline-rebasePreamble.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";

export type FinishedImplementationInput = {
    runId: string;
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    sourceBranch: string;
};

// Stamps the wait clock once, here, so every later box in this diagram measures from the same start.
export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as FinishedImplementationInput;
    const projectRoot = requireAbsolutePath("projectRoot", parsed.projectRoot);
    return {
        box: "FINISHED_IMPLEMENTATION_INPUT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        runId: parsed.runId,
        taskNumber: parsed.taskNumber,
        projectRoot,
        worktreePath: parsed.worktreePath,
        sourceBranch: parsed.sourceBranch,
        lockWaitStartedAt: new Date().toISOString(),
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
