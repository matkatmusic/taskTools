// ARE_2_TEST_FIXES_DONE, from pipeline-taskTests.mmd. Asked before amending, so the first failure's fix attempt is not spent yet.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getAttemptCount, MAX_ATTEMPTS } from "../../tackle-tasks/taskRunState.ts";
import { readPacket } from "./packet.ts";

const TEST_FIXES_COUNTER = "testFixes";

export function main(input: string): Record<string, unknown> {
    const packet = readPacket(input);
    const fixesDone = getAttemptCount(packet.taskNumber, TEST_FIXES_COUNTER, packet.projectRoot) >= MAX_ATTEMPTS;
    const next = fixesDone ? "EXIT_WORKFLOW_TASK_TESTS" : "AMEND_ENTRY_WITH_FAILING_TESTS";
    const exitType = fixesDone ? "tests-red" : "";
    const exitNote = fixesDone ? "task tests still failing after 2 fix attempts" : "";
    return { ...packet, box: "ARE_2_TEST_FIXES_DONE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, exitType, exitNote, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
