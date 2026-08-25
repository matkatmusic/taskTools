// DO_ALL_TESTS_PASS, from pipeline-suite.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktreePath: string;
    rootSourceBranch: string;
    ownedFilePaths: string[];
    testFilePaths: string[];
    suiteFixAttempts: number;
    passed: boolean;
    output: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const next = packet.passed ? "DID_CHANGES_STAY_INSIDE_FENCE" : "ARE_2_SUITE_FIXES_DONE";
    return { ...packet, box: "DO_ALL_TESTS_PASS", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
