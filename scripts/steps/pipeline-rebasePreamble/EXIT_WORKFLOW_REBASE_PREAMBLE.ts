// EXIT_WORKFLOW_REBASE_PREAMBLE, from pipeline-rebasePreamble.mmd
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

// Stub: pipeline-rebasePreamble.mmd's own logic is not implemented yet, so this hand-off fabricates the packet shape pipeline-failuresExit.mmd::EXIT_TYPE_NOTE_INPUT requires.
export function main(input: string): Record<string, unknown> {
    return {
        box: "EXIT_WORKFLOW_REBASE_PREAMBLE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: 0,
        runId: "",
        projectRoot: "",
        worktree: "",
        branch: "",
        docsMode: "",
        exitType: "",
        exitNote: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
