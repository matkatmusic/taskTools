// DO_ALL_TESTS_PASS_Q, from pipeline-runFullSuite.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    passed: boolean;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    return {
        ...packet,
        box: "DO_ALL_TESTS_PASS_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: packet.passed ? "DID_CHANGES_STAY_INSIDE_FENCE_Q" : "ARE_2_SUITE_FIXES_DONE_Q",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
