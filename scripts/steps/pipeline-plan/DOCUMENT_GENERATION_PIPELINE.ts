// DOCUMENT_GENERATION_PIPELINE, from pipeline-plan.mmd
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

// Stub: pipeline-plan.mmd's own logic is not implemented yet, so this hand-off fabricates the docs packet shape pipeline-documentGeneration.mmd::WORKTREE_DOCS_MODE_INPUT requires.
export function main(input: string): Record<string, unknown> {
    return {
        box: "DOCUMENT_GENERATION_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: 0,
        runId: "",
        projectRoot: "",
        worktree: "",
        branch: "",
        docsMode: "",
        exitType: "",
        exitNote: "",
        clarifyRequest: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
