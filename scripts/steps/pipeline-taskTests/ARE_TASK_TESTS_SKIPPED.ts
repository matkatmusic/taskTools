// ARE_TASK_TESTS_SKIPPED, from pipeline-taskTests.mmd. An entry whose tests field is "skip" runs no task tests and no codex test review.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { readPacket } from "./packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = readPacket(input);
    const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find(task => task.taskNumber === packet.taskNumber);
    if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const next = entry.tests === "skip" ? "REBASE_PREAMBLE_PIPELINE" : "RUN_TASK_TESTS";
    return { ...packet, box: "ARE_TASK_TESTS_SKIPPED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
