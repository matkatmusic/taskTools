// HAVE_15_MINUTES_PASSED, from pipeline-rebasePreamble.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type Have15MinutesPassedInput = {
    runId: string;
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    sourceBranch: string;
    lockWaitStartedAt: string;
};

// Comfortably short of the operator's stuck-lock recovery script, per the diagram's rule 4.
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Have15MinutesPassedInput;
    const elapsedMs = Date.now() - Date.parse(parsed.lockWaitStartedAt);
    const havePassed = elapsedMs >= FIFTEEN_MINUTES_MS;
    return {
        box: "HAVE_15_MINUTES_PASSED",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: havePassed ? "EXIT_WORKFLOW_REBASE_PREAMBLE" : "WAIT_FOR_LOCK",
        runId: parsed.runId,
        taskNumber: parsed.taskNumber,
        projectRoot: parsed.projectRoot,
        worktreePath: parsed.worktreePath,
        sourceBranch: parsed.sourceBranch,
        lockWaitStartedAt: parsed.lockWaitStartedAt,
        exitType: havePassed ? "run-failed" : "",
        exitNote: havePassed ? "the source repo lock did not come free within 15 minutes" : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
