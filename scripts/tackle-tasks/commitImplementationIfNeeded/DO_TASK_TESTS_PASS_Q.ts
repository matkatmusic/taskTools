// DO_TASK_TESTS_PASS_Q, from pipeline-taskTests.mmd. Decision: do the recorded task tests pass?
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getCurrentTaskRun } from "../shared/taskRunState.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

export function main(input: string): CommitImplementationIfNeededPacket & { next: string } {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    const taskTests = getCurrentTaskRun(packet.taskNumber, packet.projectRoot)?.taskTests;
    if (!taskTests) throw new Error(`task ${packet.taskNumber} has no recorded task-test run`);
    const output = { ...packet, box: "DO_TASK_TESTS_PASS_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    if (!taskTests.passed) {
        return { ...output, next: "ARE_2_TEST_FIXES_DONE_Q" };
    }
    const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
    if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    if (Number(entry.difficulty) <= 3) {
        return { ...output, next: "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO" };
    }
    return { ...output, next: "pipeline-codexReviewsTests.mmd::CODEX_REVIEWS_TESTS" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
