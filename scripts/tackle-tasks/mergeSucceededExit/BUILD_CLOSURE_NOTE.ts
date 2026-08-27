// BUILD_CLOSURE_NOTE, from pipeline-mergeSucceededExit.mmd "build the closure note from the recorded run". Read-only: runs correctly even after CLEAN_UP_WORKTREES deletes the worktree.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { buildClosureNote } from "../shared/buildClosureNote.ts";

export type BuildClosureNoteInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as BuildClosureNoteInput;
    const { closureNote } = buildClosureNote({
        taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot,
    });
    return {
        box: "BUILD_CLOSURE_NOTE", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId, closureNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
