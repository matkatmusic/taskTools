// CODEX_REVIEW_FALLBACK_OPUS: retries the review with claude opus after fable failed too.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";
import { codexReviewFallbackOpusPrompt } from "../shared/CodexReviewBodyEmitter.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const t = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    return { box: "CODEX_REVIEW_FALLBACK_OPUS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: codexReviewFallbackOpusPrompt(t) };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
