// ARE_TESTS_FLAGGED, from pipeline-areTestsFlagged.mmd. Ported from archive pipeline-reviewTests/ARE_TESTS_FLAGGED.ts.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { decideTestReview, type TestReview } from "../shared/decideTestReview.ts";
import { readReviewJson } from "../shared/readReviewJson.ts";
import type { AreTestsFlaggedPacket } from "./_packet.ts";

type CorePacket = Omit<AreTestsFlaggedPacket, "flagged" | "notes">;
// The hook merges CODEX_REVIEWS_TESTS's own input packet with the reviewer's answer; this is that merge.
type Input = CorePacket & { message: string; additionalData: { reviewFile: string } };

export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, message: _message, additionalData, ...core } = JSON.parse(input) as Input;
    const review = readReviewJson(additionalData.reviewFile) as TestReview;
    const { flagged, notes } = decideTestReview(review);
    const output = { ...core, box: "ARE_TESTS_FLAGGED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, flagged };
    if (flagged) {
        return { ...output, notes, next: "ARE_2_TEST_REVIEWS_DONE_Q" };
    }
    return { ...output, notes: "", next: "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
