// ARE_TASK_TESTS_SKIPPED_Q, from pipeline-taskTests.mmd. An entry without tests runs no task tests and no codex test review.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles, taskHasTests } from "../../taskFiles.ts";
import { TASK_HAS_TESTS } from "../../resultCodes.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

export function main(input: string): CommitImplementationIfNeededPacket & { next: string } {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
    if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const next = taskHasTests(entry) === TASK_HAS_TESTS ? "RUN_TASK_TESTS" : "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO";
    return { ...packet, box: "ARE_TASK_TESTS_SKIPPED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
