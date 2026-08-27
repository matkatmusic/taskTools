// AMEND_ENTRY_WITH_CODEX_NOTES, from pipeline-areTestsFlagged.mmd. Ported from archive pipeline-reviewTests/AMEND_ENTRY_WITH_CODEX_NOTES.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";
import type { AreTestsFlaggedPacket } from "./_packet.ts";

type Input = AreTestsFlaggedPacket & { next: string };

function amendEntryWithCodexNotes(projectRoot: string, taskNumber: number, notes: string): void {
    const pair = resolveTaskFiles(projectRoot);
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task) => task.taskNumber === taskNumber);
        if (!entry) throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
        entry.codexReviewNotes = `A reviewer flagged the task tests. Apply every fix below.\n\n${notes}`;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
}

// Only one next box, so this never prints next; IMPLEMENT_TASK re-plans from the amended tasks.json entry.
export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, next: _next, flagged: _flagged, notes, ...core } = JSON.parse(input) as Input;
    if (notes.trim() === "") throw new Error("amend-entry: no reviewer notes to write; this box runs only on a flagged review");
    amendEntryWithCodexNotes(core.projectRoot, core.taskNumber, notes);
    return { ...core, box: "AMEND_ENTRY_WITH_CODEX_NOTES", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
