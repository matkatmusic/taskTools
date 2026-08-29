// READ_MERGE_PUBLICATION_STATE, from pipeline-runFullSuite.mmd. Read-only reconciliation over the layer merge refs.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readPublicationState } from "../shared/readPublicationState.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
};

export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as Input & { next?: string };
    const result = readPublicationState({
        taskNumber: packet.taskNumber,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        rootSourceBranch: "staging",
    });
    return { ...packet, ...result, box: "READ_MERGE_PUBLICATION_STATE", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
