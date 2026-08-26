// DID_CHANGES_STAY_INSIDE_FENCE, from pipeline-suite.mmd. Re-derives the diff; never trusts a self-report.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { checkTaskFileFence } from "../../tackle-tasks/checkTaskFileFence.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktreePath: string;
    rootSourceBranch: string;
    ownedFilePaths: string[];
    testFilePaths: string[];
    suiteFixAttempts: number;
    output: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const { inside } = checkTaskFileFence({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        rootSourceBranch: packet.rootSourceBranch,
    });
    const next = inside ? "MERGE_PIPELINE" : "EXIT_WORKFLOW_SUITE";
    const exitType = inside ? "" : "fence-violation";
    const exitNote = inside ? "" : "a repair edited files the task does not own. nothing merged. worktree preserved.";
    return {
        box: "DID_CHANGES_STAY_INSIDE_FENCE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        rootSourceBranch: packet.rootSourceBranch,
        ownedFilePaths: packet.ownedFilePaths,
        testFilePaths: packet.testFilePaths,
        suiteFixAttempts: packet.suiteFixAttempts,
        output: packet.output,
        next,
        exitType,
        exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
