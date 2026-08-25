// PLAN_PIPELINE, from pipeline-documentGeneration.mmd. Cross-diagram exit box into pipeline-plan.mmd::DOCS_INPUT.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Incoming = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Incoming;
    return {
        box: "PLAN_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktree: packet.worktree,
        branch: packet.branch,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
