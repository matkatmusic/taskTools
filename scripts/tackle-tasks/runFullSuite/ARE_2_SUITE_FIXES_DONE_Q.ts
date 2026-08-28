// ARE_2_SUITE_FIXES_DONE_Q, from pipeline-runFullSuite.mmd. Counts fix attempts, persisted per run.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { MAX_ATTEMPTS, raiseAttemptCount } from "../shared/taskRunState.ts";
import { readCheckpoint } from "../shared/checkpoint.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    output: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const checkpoint = readCheckpoint(packet.worktree);
    if (checkpoint === null) throw new Error(`ARE_2_SUITE_FIXES_DONE_Q: no checkpoint in ${packet.worktree}`);
    const attempts = raiseAttemptCount(packet.taskNumber, packet.runId, "suiteFix", checkpoint.passId, packet.projectRoot);
    const done = attempts >= MAX_ATTEMPTS;
    return {
        ...packet,
        box: "ARE_2_SUITE_FIXES_DONE_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: done ? "pipeline-failuresExit.mmd::FAILURES_EXIT" : "pipeline-fixTheCodebaseForSuite.mmd::FIX_THE_CODEBASE_FOR_SUITE",
        exitType: done ? "suite-red" : "",
        exitNote: done ? "full suite still red after 2 fix attempts. merge aborted. worktree preserved." : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
