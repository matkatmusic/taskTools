// SOURCE_REPO_LOCKED_INPUT, from pipeline-rebase.mmd. Diagram entry: builds the packet every later box in this pipeline carries forward.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { RebasePacket } from "./packet.ts";

export type SourceRepoLockedInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    stepId: string;
    rootSourceBranch: string;
    landedOccurrenceIds: string[];
    suiteFixAttempts: number;
};

export function main(input: string): RebasePacket {
    const packet = JSON.parse(input) as SourceRepoLockedInput;
    return {
        box: "SOURCE_REPO_LOCKED_INPUT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: packet.stepId,
        rootSourceBranch: packet.rootSourceBranch,
        landedOccurrenceIds: packet.landedOccurrenceIds,
        suiteFixAttempts: packet.suiteFixAttempts,
        conflicted: false,
        stoppedOccurrenceId: "",
        stoppedCheckoutPath: "",
        conflictedFilePaths: [],
        finished: false,
        failureReason: "",
        exitType: "",
        exitNote: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
