// CODEX_TEST_REVIEW_FALLBACK_OPUS: retries the review with claude opus after fable failed too.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { CodexReviewsTestsPacket } from "./_packet.ts";
import { codexTestReviewFallbackOpusPrompt } from "../shared/CodexTestReviewBodyEmitter.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CodexReviewsTestsPacket;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    return { box: "CODEX_TEST_REVIEW_FALLBACK_OPUS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: codexTestReviewFallbackOpusPrompt(prepared) };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
