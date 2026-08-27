// DO_TASK_TESTS_PASS_Q, from pipeline-taskTests.mmd. Decision: do the recorded task tests pass?
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getCurrentTaskRun } from "../shared/taskRunState.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

export function main(input: string): CommitImplementationIfNeededPacket & { next: string } {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    const taskTests = getCurrentTaskRun(packet.taskNumber, packet.projectRoot)?.taskTests;
    if (!taskTests) throw new Error(`task ${packet.taskNumber} has no recorded task-test run`);
    const next = taskTests.passed ? "pipeline-codexReviewsTests.mmd::CODEX_REVIEWS_TESTS" : "ARE_2_TEST_FIXES_DONE_Q";
    return { ...packet, box: "DO_TASK_TESTS_PASS_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
