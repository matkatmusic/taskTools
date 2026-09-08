// IS_PLAN_APPROVED_BY_DEFAULT_Q, from pipeline-codexReviewsPlan.mmd. A task re-run after a scrapped-plan exit skips the review agent: YES writes an approved review file.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { readCheckpoint } from "../shared/checkpoint.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const output = { ...packet, box: "IS_PLAN_APPROVED_BY_DEFAULT_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    if (readCheckpoint(packet.worktree)?.resumedFrom?.exitType !== "plan-scrapped") {
        // The hook checks every branch against the one output template, so the NO branch carries the review keys empty.
        return { ...output, message: "", additionalData: { reviewFile: "" }, next: "CODEX_REVIEWS_PLAN" };
    }
    // Same path preparedTask.ts gives CODEX_REVIEWS_PLAN as reviewOutputFile.
    const reviewFile = join(packet.worktree, "plans", "codex-review.json");
    writeJsonAtomically(reviewFile, { outcome: "OK", missingFiles: [], message: "", issues: [], fixes: [] });
    return { ...output, message: "", additionalData: { reviewFile }, next: "pipeline-whatIsReviewVerdict.mmd::WHAT_IS_REVIEW_VERDICT" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
