// RUN_TASK_TESTS, from pipeline-taskTests.mmd. Runs the task's own tests and records the result for DO_TASK_TESTS_PASS_Q to read.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL, type ResetScope } from "../../contracts.ts";
import { runTaskTests } from "../shared/runTaskTestsImpl.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

export const resetScope: ResetScope = { counters: true };

export async function main(input: string): Promise<CommitImplementationIfNeededPacket> {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    await runTaskTests(packet.taskNumber, packet.runId, packet.worktree, "RUN_TASK_TESTS", packet.projectRoot);
    return { ...packet, box: "RUN_TASK_TESTS", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(await main(process.argv[2] ?? "")));
