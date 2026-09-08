// MERGE_PIPELINE, from pipeline-suite.mmd. Crosses to pipeline-merge.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktreePath: string;
    rootSourceBranch: string;
    suiteFixAttempts: number;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    return {
        box: "MERGE_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        rootSourceBranch: packet.rootSourceBranch,
        suiteFixAttempts: packet.suiteFixAttempts,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
