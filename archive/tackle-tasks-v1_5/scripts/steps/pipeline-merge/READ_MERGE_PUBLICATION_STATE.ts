// READ_MERGE_PUBLICATION_STATE, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readPublicationState } from "../../tackle-tasks/readPublicationState.ts";

type Incoming = {
    worktreePath: string;
    rootSourceBranch: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    suiteFixAttempts: number;
};

// Read-only reconciliation over the layer merge refs; never trusts MERGE_WORKTREES's own return.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Incoming;
    const result = readPublicationState({
        taskNumber: packet.taskNumber,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
    });
    return {
        worktreePath: packet.worktreePath,
        rootSourceBranch: packet.rootSourceBranch,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        suiteFixAttempts: packet.suiteFixAttempts,
        ...result,
        box: "READ_MERGE_PUBLICATION_STATE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
