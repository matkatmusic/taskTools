// EXIT_WORKFLOW_REVIEW_TESTS, from pipeline-reviewTests.mmd. Hands off to pipeline-failuresExit.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

// Reached from ARE_2_TEST_REVIEWS_DONE's exit branch, whose envelope carries an unread `next`.
type ExitArrival = {
    projectRoot?: string; taskNumber?: number; worktreePath?: string; sourceBranch?: string;
    exitType: string; exitNote: string;
};

export function main(input: string): Record<string, unknown> {
    const arrival = JSON.parse(input) as ExitArrival;
    return {
        box: "EXIT_WORKFLOW_REVIEW_TESTS",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: arrival.projectRoot ?? "",
        taskNumber: arrival.taskNumber ?? 0,
        worktreePath: arrival.worktreePath ?? "",
        sourceBranch: arrival.sourceBranch ?? "",
        exitType: arrival.exitType,
        exitNote: arrival.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
