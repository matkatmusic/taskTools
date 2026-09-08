// IS_TASK_ACTIVE_Q, from pipeline-preambleStatusCheck.mmd. "is the task active?"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { readTaskRunState } from "../shared/taskRunState.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    if (readTaskRunState(packet.taskNumber, packet.projectRoot).active) {
        return { ...packet, box: "IS_TASK_ACTIVE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, exitType: "already-active", exitNote: "a previous run left the task active", next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT" };
    }
    return { ...packet, box: "IS_TASK_ACTIVE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "PREFLIGHT_OK_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
