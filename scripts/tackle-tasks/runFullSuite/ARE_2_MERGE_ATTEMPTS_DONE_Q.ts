// ARE_2_MERGE_ATTEMPTS_DONE_Q, from pipeline-runFullSuite.mmd. Counts merge attempts, persisted per run.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { MAX_ATTEMPTS, raiseAttemptCount } from "../shared/taskRunState.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const attempts = raiseAttemptCount(packet.taskNumber, packet.runId, "merge", packet.projectRoot);
    const done = attempts >= MAX_ATTEMPTS;
    return {
        ...packet,
        box: "ARE_2_MERGE_ATTEMPTS_DONE_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: done ? "pipeline-failuresExit.mmd::FAILURES_EXIT" : "pipeline-rebase.mmd::REBASE_ONTO_TARGET_BRANCH",
        exitType: done ? "merge-failed" : "",
        exitNote: done ? "nothing landed after 2 attempts. worktree preserved." : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
