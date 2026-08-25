// ARE_2_SUITE_FIXES_DONE, from pipeline-suite.mmd. Counts fix attempts, per-invocation only.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

const MAX_SUITE_FIX_ATTEMPTS = 2;

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
    const done = packet.suiteFixAttempts >= MAX_SUITE_FIX_ATTEMPTS;
    const next = done ? "EXIT_WORKFLOW_SUITE" : "FIX_THE_CODEBASE_FOR_SUITE";
    const exitType = done ? "suite-red" : "";
    const exitNote = done ? "full suite still red after 2 fix attempts. merge aborted. worktree preserved." : "";
    return {
        box: "ARE_2_SUITE_FIXES_DONE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        rootSourceBranch: packet.rootSourceBranch,
        ownedFilePaths: packet.ownedFilePaths,
        testFilePaths: packet.testFilePaths,
        suiteFixAttempts: done ? packet.suiteFixAttempts : packet.suiteFixAttempts + 1,
        output: packet.output,
        next,
        exitType,
        exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
