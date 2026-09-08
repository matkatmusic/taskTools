// COMMIT_SUITE_FIX_IF_NEEDED, from pipeline-suite.mmd. Mutating: commits dirty layers if any.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { commitTaskWork } from "../../tackle-tasks/commitTaskWork.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktreePath: string;
    rootSourceBranch: string;
    ownedFilePaths: string[];
    testFilePaths: string[];
    suiteFixAttempts: number;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const stepId = `fix-suite-${packet.suiteFixAttempts}`;
    commitTaskWork({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId,
        rootSourceBranch: packet.rootSourceBranch,
    });
    return {
        box: "COMMIT_SUITE_FIX_IF_NEEDED",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        rootSourceBranch: packet.rootSourceBranch,
        ownedFilePaths: packet.ownedFilePaths,
        testFilePaths: packet.testFilePaths,
        suiteFixAttempts: packet.suiteFixAttempts,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
