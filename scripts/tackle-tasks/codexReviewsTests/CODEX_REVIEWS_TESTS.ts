// CODEX_REVIEWS_TESTS, from pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts, folded with GREEN_IMPLEMENTATION_INPUT's packet validation.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";
import { reviewTestsPrompt } from "../shared/CodexTestReviewBodyEmitter.ts";
import type { CodexReviewsTestsPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CodexReviewsTestsPacket;
    if (!Number.isInteger(packet.taskNumber)) throw new Error("taskNumber is required");
    if (typeof packet.runId !== "string" || packet.runId === "") throw new Error("runId is required");
    if (typeof packet.branch !== "string" || packet.branch === "") throw new Error("branch is required");
    const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
    const worktree = requireAbsolutePath("worktree", packet.worktree);
    const prepared = loadPreparedTask(packet.taskNumber, worktree, projectRoot);
    return { box: "CODEX_REVIEWS_TESTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: reviewTestsPrompt(prepared) };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
