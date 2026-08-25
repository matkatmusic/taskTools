// ARE_2_TEST_REVIEWS_DONE, from pipeline-reviewTests.mmd. A second flagged review exits the pipeline.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import type { ReviewTestsCorePacket } from "./GREEN_IMPLEMENTATION_INPUT.ts";

type IncomingPacket = ReviewTestsCorePacket & { box: string; scriptSignal: string; next: string; notes: string };

// A non-empty codexReviewNotes means a prior flagged review already amended this entry once.
function hasAlreadyBeenAmended(projectRoot: string, taskNumber: number): boolean {
    const pair = resolveTaskFiles(projectRoot);
    const entry = readTaskFile(pair.tasksPath).find((task) => task.taskNumber === taskNumber);
    if (!entry) throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
    return typeof entry.codexReviewNotes === "string" && entry.codexReviewNotes.trim() !== "";
}

export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, next: _next, notes, ...core } = JSON.parse(input) as IncomingPacket;
    const reviewsDone = hasAlreadyBeenAmended(core.projectRoot, core.taskNumber);
    const next = reviewsDone ? "EXIT_WORKFLOW_REVIEW_TESTS" : "AMEND_ENTRY_WITH_CODEX_NOTES";
    return {
        box: "ARE_2_TEST_REVIEWS_DONE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next,
        ...core,
        notes: reviewsDone ? "" : notes,
        exitType: reviewsDone ? "tests-flagged" : "",
        exitNote: reviewsDone ? "task tests failed codex review" : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
