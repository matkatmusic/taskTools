// ARE_2_TEST_REVIEWS_DONE_Q, from pipeline-areTestsFlagged.mmd. Ported from archive pipeline-reviewTests/ARE_2_TEST_REVIEWS_DONE.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";
import { TEST_REVIEW_ALREADY_AMENDED, TEST_REVIEW_NOT_YET_AMENDED } from "../../shared/resultCodes.ts";
import type { AreTestsFlaggedPacket } from "./_packet.ts";

type Input = AreTestsFlaggedPacket & { next: string };

// A non-empty codexReviewNotes means a prior flagged review already amended this entry once.
function hasAlreadyBeenAmended(projectRoot: string, taskNumber: number): number {
    const pair = resolveTaskFiles(projectRoot);
    const entry = readTaskFile(pair.tasksPath).find((task) => task.taskNumber === taskNumber);
    if (!entry) throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
    return typeof entry.codexReviewNotes === "string" && entry.codexReviewNotes.trim() !== ""
        ? TEST_REVIEW_ALREADY_AMENDED : TEST_REVIEW_NOT_YET_AMENDED;
}

export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, next: _next, notes, ...core } = JSON.parse(input) as Input;
    const reviewsDone = hasAlreadyBeenAmended(core.projectRoot, core.taskNumber);
    const output = { ...core, box: "ARE_2_TEST_REVIEWS_DONE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    if (reviewsDone === TEST_REVIEW_ALREADY_AMENDED) {
        return {
            ...output, notes: "", exitType: "tests-flagged", exitNote: "task tests failed codex review",
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    return { ...output, notes, next: "AMEND_ENTRY_WITH_CODEX_NOTES" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
