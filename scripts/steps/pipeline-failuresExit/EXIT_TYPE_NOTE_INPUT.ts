// EXIT_TYPE_NOTE_INPUT, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

// Only exitType and exitNote are new at this cross-diagram entry; other fields ride along.
export type FailuresExitEntryInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    sourceBranch: string;
    exitType: string;
    exitNote: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as FailuresExitEntryInput;
    return { ...packet, box: "EXIT_TYPE_NOTE_INPUT", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
