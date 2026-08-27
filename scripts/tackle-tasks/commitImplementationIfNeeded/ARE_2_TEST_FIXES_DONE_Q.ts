// ARE_2_TEST_FIXES_DONE_Q, from pipeline-taskTests.mmd. Asked before amending, so the first failure's fix attempt is not spent yet.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getAttemptCount, MAX_ATTEMPTS } from "../shared/taskRunState.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

export function main(input: string): CommitImplementationIfNeededPacket & { next: string } {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    const fixesDone = getAttemptCount(packet.taskNumber, "testFixes", packet.projectRoot) >= MAX_ATTEMPTS;
    if (fixesDone) {
        return {
            ...packet, box: "ARE_2_TEST_FIXES_DONE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            exitType: "tests-red", exitNote: "task tests still failing after 2 fix attempts",
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    return { ...packet, box: "ARE_2_TEST_FIXES_DONE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "AMEND_ENTRY_WITH_FAILING_TESTS" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
