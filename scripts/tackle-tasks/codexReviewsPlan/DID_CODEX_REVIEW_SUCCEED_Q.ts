// DID_CODEX_REVIEW_SUCCEED_Q: routes to the ruling on success, else to the fable fallback.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

type Input = EntryPacket & { message: string; additionalData: { reviewFile: string; codexSucceeded: boolean } };

export function main(input: string): Record<string, unknown> {
    const { additionalData, ...packet } = JSON.parse(input) as Input;
    const output = { ...packet, box: "DID_CODEX_REVIEW_SUCCEED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, message: "", additionalData: { reviewFile: additionalData.reviewFile } };
    if (additionalData.codexSucceeded) {
        return { ...output, next: "pipeline-whatIsReviewVerdict.mmd::WHAT_IS_REVIEW_VERDICT" };
    }
    return { ...output, next: "CODEX_REVIEW_FALLBACK_FABLE" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
