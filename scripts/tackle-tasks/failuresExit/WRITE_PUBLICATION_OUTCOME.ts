// WRITE_PUBLICATION_OUTCOME, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { writeTaskExitNotes } from "../shared/writeTaskExitNotes.ts";
import { getCurrentTaskRun, updateCurrentTaskRun } from "../shared/taskRunState.ts";
import type { EntryPacket } from "./_packet.ts";

// Work landed: keep completed if it is already there, else write partially-published. Never run-failed.
export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const alreadyCompleted = getCurrentTaskRun(packet.taskNumber, packet.projectRoot)?.exitType === "completed";
    const exitType = alreadyCompleted ? "completed" : "partially-published";
    writeTaskExitNotes({ taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot, exitType, exitNote: packet.exitNote });
    updateCurrentTaskRun(packet.taskNumber, packet.runId, { cleanupIncomplete: true }, packet.projectRoot);
    return { ...packet, box: "WRITE_PUBLICATION_OUTCOME", scriptSignal: SCRIPT_SIGNAL.CONTINUE, exitType };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
