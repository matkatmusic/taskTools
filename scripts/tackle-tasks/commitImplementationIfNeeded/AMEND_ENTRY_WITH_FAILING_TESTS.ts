// AMEND_ENTRY_WITH_FAILING_TESTS, from pipeline-taskTests.mmd. Writes failing-test notes into tasks.json and raises the fix-attempt counter.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { amendEntryWithFailingTests } from "../shared/amendEntryWithFailingTestsImpl.ts";
import { raiseAttemptCount } from "../shared/taskRunState.ts";
import { readCheckpoint } from "../shared/checkpoint.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

export function main(input: string): CommitImplementationIfNeededPacket {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    amendEntryWithFailingTests({ projectRoot: packet.projectRoot, taskNumber: packet.taskNumber });
    const checkpoint = readCheckpoint(packet.worktree);
    if (checkpoint === null) throw new Error(`AMEND_ENTRY_WITH_FAILING_TESTS: no checkpoint in ${packet.worktree}`);
    raiseAttemptCount(packet.taskNumber, packet.runId, "testFixes", checkpoint.passId, packet.projectRoot);
    return { ...packet, box: "AMEND_ENTRY_WITH_FAILING_TESTS", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
