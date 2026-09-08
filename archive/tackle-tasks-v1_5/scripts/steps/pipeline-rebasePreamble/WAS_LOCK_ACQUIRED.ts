// WAS_LOCK_ACQUIRED, from pipeline-rebasePreamble.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type WasLockAcquiredInput = {
    runId: string;
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    sourceBranch: string;
    lockWaitStartedAt: string;
    acquired: boolean;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as WasLockAcquiredInput;
    return {
        box: "WAS_LOCK_ACQUIRED",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: parsed.acquired ? "REBASE_PIPELINE" : "HAVE_15_MINUTES_PASSED",
        runId: parsed.runId,
        taskNumber: parsed.taskNumber,
        projectRoot: parsed.projectRoot,
        worktreePath: parsed.worktreePath,
        sourceBranch: parsed.sourceBranch,
        lockWaitStartedAt: parsed.lockWaitStartedAt,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
