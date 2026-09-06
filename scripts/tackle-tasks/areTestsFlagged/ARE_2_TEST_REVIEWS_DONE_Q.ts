// ARE_2_TEST_REVIEWS_DONE_Q, from pipeline-areTestsFlagged.mmd. Ported from archive pipeline-reviewTests/ARE_2_TEST_REVIEWS_DONE.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getAttemptCount, MAX_ATTEMPTS } from "../shared/taskRunState.ts";
import type { AreTestsFlaggedPacket } from "./_packet.ts";

type Input = AreTestsFlaggedPacket & { next: string };

// Asked before amending, so the first flagged review's fix attempt is not spent yet.
export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, next: _next, notes, ...core } = JSON.parse(input) as Input;
    const reviewsDone = getAttemptCount(core.taskNumber, "testReviews", core.projectRoot) >= MAX_ATTEMPTS;
    const output = { ...core, box: "ARE_2_TEST_REVIEWS_DONE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    if (reviewsDone) {
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
