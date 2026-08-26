// ARE_2_MERGE_ATTEMPTS_DONE, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { MAX_ATTEMPTS, raiseAttemptCount } from "../../tackle-tasks/taskRunState.ts";

type Incoming = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
};

const EXIT_NOTE = "nothing landed after 2 attempts. worktree preserved.";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Incoming;
    const attempts = raiseAttemptCount(packet.taskNumber, packet.runId, "merge", packet.projectRoot);
    const done = attempts >= MAX_ATTEMPTS;
    return {
        ...packet,
        box: "ARE_2_MERGE_ATTEMPTS_DONE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: done ? "EXIT_WORKFLOW_MERGE" : "REBASE_PIPELINE",
        // Exit fields ride as empty strings on the happy (re-enter rebase) branch.
        exitType: done ? "merge-failed" : "",
        exitNote: done ? EXIT_NOTE : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
