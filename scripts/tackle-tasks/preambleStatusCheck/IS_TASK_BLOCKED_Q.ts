// IS_TASK_BLOCKED_Q, from pipeline-preambleStatusCheck.mmd. "is the task blocked?"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { isTaskBlocked } from "../shared/isTaskBlocked.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    if (isTaskBlocked(packet.taskNumber, packet.projectRoot).blocked) {
        return { ...packet, box: "IS_TASK_BLOCKED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, exitType: "blocked", exitNote: "an open blocker remains", next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT" };
    }
    return { ...packet, box: "IS_TASK_BLOCKED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "IS_TASK_ACTIVE_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
