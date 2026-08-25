// RUN_FULL_SUITE, from pipeline-suite.mmd. Mutating: runs the target worktree's real test suite.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { runFullSuite } from "../../tackle-tasks/runFullSuite.ts";

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
    const stepId = `run-full-suite-${packet.suiteFixAttempts}`;
    const result = runFullSuite(
        packet.taskNumber, packet.runId, packet.worktreePath, packet.rootSourceBranch, stepId, packet.projectRoot,
    );
    return {
        box: "RUN_FULL_SUITE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        rootSourceBranch: packet.rootSourceBranch,
        ownedFilePaths: packet.ownedFilePaths,
        testFilePaths: packet.testFilePaths,
        suiteFixAttempts: packet.suiteFixAttempts,
        passed: result.passed,
        output: result.output,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
