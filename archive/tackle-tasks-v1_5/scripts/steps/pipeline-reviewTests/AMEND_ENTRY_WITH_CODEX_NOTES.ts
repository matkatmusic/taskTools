// AMEND_ENTRY_WITH_CODEX_NOTES, from pipeline-reviewTests.mmd. Ported from scripts/tackle-tasks/amendEntryWithCodexNotes.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";
import type { ReviewTestsCorePacket } from "./GREEN_IMPLEMENTATION_INPUT.ts";

type IncomingPacket = ReviewTestsCorePacket & {
    box: string; scriptSignal: string; next: string; notes: string; exitType: string; exitNote: string;
};

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

export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, next: _next, exitType: _exitType, exitNote: _exitNote, notes, ...core } = JSON.parse(input) as IncomingPacket;
    if (notes.trim() === "") throw new Error("amend-entry: no reviewer notes to write; this box runs only on a flagged review");
    amendEntryWithCodexNotes(core.projectRoot, core.taskNumber, notes);
    return { box: "AMEND_ENTRY_WITH_CODEX_NOTES", scriptSignal: SCRIPT_SIGNAL.CONTINUE, ...core, amended: true };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
