// REBASE_PIPELINE, from pipeline-rebasePreamble.mmd Cross-diagram exit box into pipeline-rebase.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type RebasePipelineInput = {
    runId: string;
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    sourceBranch: string;
};

// A fresh implementation has no merge history yet, so no layer has landed.
const REBASE_STEP_ID = "rebase";

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as RebasePipelineInput;
    return {
        box: "REBASE_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: parsed.projectRoot,
        worktreePath: parsed.worktreePath,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        stepId: REBASE_STEP_ID,
        rootSourceBranch: parsed.sourceBranch,
        landedOccurrenceIds: [],
        suiteFixAttempts: 0,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
