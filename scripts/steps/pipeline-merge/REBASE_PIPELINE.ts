// REBASE_PIPELINE, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

// Re-enter rebase, not the rebase preamble: the target branch tip moved (paragraph 75).
const REBASE_STEP_ID = "rebase";

type Incoming = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    rootSourceBranch: string;
    suiteFixAttempts: number;
    landed: string[];
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Incoming;
    return {
        box: "REBASE_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: REBASE_STEP_ID,
        rootSourceBranch: packet.rootSourceBranch,
        landedOccurrenceIds: packet.landed,
        suiteFixAttempts: packet.suiteFixAttempts,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
