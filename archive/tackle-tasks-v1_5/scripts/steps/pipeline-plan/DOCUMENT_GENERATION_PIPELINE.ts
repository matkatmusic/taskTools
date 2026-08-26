// DOCUMENT_GENERATION_PIPELINE, from pipeline-plan.mmd goes to pipeline-documentGeneration.mmd::WORKTREE_DOCS_MODE_INPUT, docs mode UPDATE.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    clarifyRequest: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    return {
        box: "DOCUMENT_GENERATION_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        projectRoot: parsed.projectRoot,
        worktree: parsed.worktree,
        branch: parsed.sourceBranch,
        docsMode: "UPDATE",
        exitType: "",
        exitNote: "",
        clarifyRequest: parsed.clarifyRequest,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
