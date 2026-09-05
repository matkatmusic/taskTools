// IS_DIFFICULTY_7_PLUS_Q, from pipeline-planTheTask.mmd. Decision: does this task's difficulty route the plan to codex?
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const packet = JSON.parse(input) as EntryPacket;
    const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
    if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const output = { ...packet, box: "IS_DIFFICULTY_7_PLUS_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    if (Number(entry.difficulty) >= 7) {
        return { ...output, next: "PLAN_THE_TASK_CODEX" };
    }
    return { ...output, next: "PLAN_THE_TASK" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
