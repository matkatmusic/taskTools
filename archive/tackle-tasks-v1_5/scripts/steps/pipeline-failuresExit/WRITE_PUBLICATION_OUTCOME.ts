// WRITE_PUBLICATION_OUTCOME, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { writeTaskExitNotes } from "../../tackle-tasks/writeTaskExitNotes.ts";
import { getCurrentTaskRun, updateCurrentTaskRun } from "../../tackle-tasks/taskRunState.ts";
import type { FailuresExitEntryInput } from "./EXIT_TYPE_NOTE_INPUT.ts";
import type { PublicationState } from "../../tackle-tasks/readPublicationState.ts";

type Input = FailuresExitEntryInput & { publicationState: PublicationState; next: string };

// Work landed: keep completed if it is already there, else write partially-published. Never run-failed.
export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as Input;
    const alreadyCompleted = getCurrentTaskRun(packet.taskNumber, packet.projectRoot)?.exitType === "completed";
    const exitType = alreadyCompleted ? "completed" : "partially-published";
    writeTaskExitNotes({ taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot, exitType, exitNote: packet.exitNote });
    updateCurrentTaskRun(packet.taskNumber, packet.runId, { cleanupIncomplete: true }, packet.projectRoot);
    return { ...packet, box: "WRITE_PUBLICATION_OUTCOME", scriptSignal: SCRIPT_SIGNAL.CONTINUE, exitType };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
