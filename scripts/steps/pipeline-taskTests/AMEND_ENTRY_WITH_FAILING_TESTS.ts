// AMEND_ENTRY_WITH_FAILING_TESTS, from pipeline-taskTests.mmd. Writes failing-test notes into tasks.json and raises the fix-attempt counter.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { amendEntryWithFailingTests } from "../../tackle-tasks/amendEntryWithFailingTestsImpl.ts";
import { raiseAttemptCount } from "../../tackle-tasks/taskRunState.ts";
import { readPacket } from "./packet.ts";

const TEST_FIXES_COUNTER = "testFixes";

export function main(input: string): Record<string, unknown> {
    const packet = readPacket(input);
    amendEntryWithFailingTests({ projectRoot: packet.projectRoot, taskNumber: packet.taskNumber });
    raiseAttemptCount(packet.taskNumber, packet.runId, TEST_FIXES_COUNTER, packet.projectRoot);
    return { ...packet, box: "AMEND_ENTRY_WITH_FAILING_TESTS", scriptSignal: SCRIPT_SIGNAL.CONTINUE, amendFailingTests: true };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
