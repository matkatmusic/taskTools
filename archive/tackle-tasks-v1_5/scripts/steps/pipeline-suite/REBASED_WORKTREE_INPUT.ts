// REBASED_WORKTREE_INPUT, from pipeline-suite.mmd. Strict entry: the real output of pipeline-rebase.mmd::SUITE_PIPELINE.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { loadPreparedTask } from "../../tackle-tasks/preparedTask.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktreePath: string;
    rootSourceBranch: string;
    suiteFixAttempts: number;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktreePath, packet.projectRoot);
    return {
        box: "REBASED_WORKTREE_INPUT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        rootSourceBranch: packet.rootSourceBranch,
        ownedFilePaths: prepared.ownedFilePaths,
        testFilePaths: prepared.testFilePaths,
        suiteFixAttempts: packet.suiteFixAttempts,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
